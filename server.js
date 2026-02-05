const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const WebSocket = require('ws');
const compression = require('compression');

const app = express();
const mesasEnUso = new Map();

// Cargar configuración desde archivo JSON
let config;
try {
    const configFile = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
    config = JSON.parse(configFile);
    console.log('✅ Configuración cargada desde config.json');
} catch (error) {
    console.error('❌ Error al cargar config.json:', error.message);
    process.exit(1);
}

const port = config.server.port;

// Middleware
app.use(compression());
app.use(cors());
app.use(express.json());

// Servir archivos estáticos con caché
app.use(express.static('.', {
    maxAge: '1h',
    etag: true
}));

// Configuración de la base de datos (desde config.json) con optimizaciones de pool
const dbConfig = {
    ...config.database,
    pool: {
        min: 2,                  // Mantener mínimo 2 conexiones siempre abiertas
        max: 10,                 // Máximo 10 conexiones
        idleTimeoutMillis: 600000  // 10 minutos antes de cerrar conexión inactiva (en lugar de 30s por defecto)
    },
    options: {
        ...config.database.options,
        enableArithAbort: true,
        trustServerCertificate: config.database.options?.trustServerCertificate !== undefined
            ? config.database.options.trustServerCertificate
            : true
    }
};

// Configuración del TPV (desde config.json)
const TPV_CONFIG = config.tpv;

// Pool de conexiones
let pool;

// Estado en memoria de los pedidos por mesa (IdCliente)
const pedidosMesas = new Map();

// Función para obtener conexión
async function getConnection() {
    try {
        if (!pool) {
            console.log('Creando nuevo pool de conexiones...');
            pool = await sql.connect(dbConfig);
            console.log('✅ Pool de conexiones creado exitosamente');

            // Iniciar keep-alive después de crear el pool
            iniciarKeepAlive();
        }
        return pool;
    } catch (err) {
        console.error('Error al conectar con la base de datos:', err);
        throw err;
    }
}

// =============================================
// KEEP-ALIVE - Mantener conexiones y caché calientes
// =============================================

let keepAliveInterval = null;

function iniciarKeepAlive() {
    if (keepAliveInterval) {
        return; // Ya está iniciado
    }

    console.log('🔥 Iniciando keep-alive cada 3 minutos...');

    // Ejecutar keep-alive cada 3 minutos
    keepAliveInterval = setInterval(async () => {
        try {
            if (!pool) return;

            // Query ligera para mantener conexión activa
            await pool.request().query('SELECT 1 as KeepAlive');

            // Query para mantener procedimientos compilados en caché
            // Esto ejecuta el SP con parámetros dummy para compilarlo
            try {
                await pool.request().query(`
                    DECLARE @oXML XML, @iXML NVARCHAR(MAX);
                    SET @iXML = '<data><IdCaja>${TPV_CONFIG.IdCaja}</IdCaja><IdCliente>0000</IdCliente><IdEmpleado>0</IdEmpleado><IdEmpresa>0</IdEmpresa></data>';
                    EXEC pTPV_Crear_Ticket_Comandas @iXML = @iXML, @oXML = @oXML OUTPUT;
                `);
            } catch (spError) {
                // Ignorar errores del SP dummy, solo queremos compilarlo
            }

            console.log('🔥 Keep-alive ejecutado correctamente');
        } catch (err) {
            console.error('⚠️ Error en keep-alive:', err.message);
        }
    }, 3 * 60 * 1000); // 3 minutos
}

// Limpiar keep-alive al cerrar
process.on('SIGINT', () => {
    console.log('⏹️  Deteniendo keep-alive...');
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
    }
    process.exit(0);
});

// =============================================
// RUTAS API - EMPLEADOS (LOGIN)
// =============================================

// Obtener empleados activos para login
app.get('/api/empleados', async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().query(`
            SELECT IdEmpleado, Nombre 
            FROM Pers_comandas_empleados 
            WHERE Activo = 1 AND PIN IS NOT NULL AND PIN != ''
            ORDER BY Nombre
        `);

        res.json(result.recordset);
    } catch (err) {
        console.error('Error al obtener empleados:', err);
        res.status(500).json({ error: 'Error al obtener empleados' });
    }
});

// Ocupar mesa (cuando alguien la abre)
app.post('/api/mesas/:idCliente/ocupar', async (req, res) => {
    const idCliente = req.params.idCliente;
    const { idEmpleado, nombreEmpleado } = req.body;

    // Verificar si ya está en uso por otro
    const enUso = mesasEnUso.get(idCliente);
    if (enUso && enUso.idEmpleado !== idEmpleado) {
        return res.status(409).json({
            success: false,
            error: 'Mesa en uso',
            empleado: enUso.nombre
        });
    }

    // Marcar como en uso
    mesasEnUso.set(idCliente, {
        idEmpleado,
        nombre: nombreEmpleado,
        desde: new Date()
    });

    console.log(`🔒 Mesa ${idCliente} ocupada por ${nombreEmpleado}`);

    // Notificar a todos
    notificarClientes('mesa_en_uso', { idCliente, empleado: nombreEmpleado, idEmpleado });

    res.json({ success: true });
});

// Liberar mesa (cuando alguien la cierra)
app.post('/api/mesas/:idCliente/liberar', async (req, res) => {
    const idCliente = req.params.idCliente;
    const { idEmpleado } = req.body;

    const enUso = mesasEnUso.get(idCliente);

    // Solo puede liberar quien la ocupó
    if (enUso && enUso.idEmpleado === idEmpleado) {
        mesasEnUso.delete(idCliente);
        console.log(`🔓 Mesa ${idCliente} liberada`);

        // Notificar a todos
        notificarClientes('mesa_liberada', { idCliente });
    }

    res.json({ success: true });
});

// Obtener mesas en uso
app.get('/api/mesas/en-uso', (req, res) => {
    const enUso = {};
    mesasEnUso.forEach((value, key) => {
        enUso[key] = value;
    });
    res.json(enUso);
});

// Login con PIN
app.post('/api/login', async (req, res) => {
    const { idEmpleado, pin } = req.body;

    try {
        const pool = await getConnection();
        const result = await pool.request()
            .input('IdEmpleado', sql.Int, idEmpleado)
            .input('PIN', sql.VarChar(10), pin)
            .query(`
                SELECT IdEmpleado, Nombre 
                FROM Pers_comandas_empleados 
                WHERE IdEmpleado = @IdEmpleado AND PIN = @PIN AND Activo = 1
            `);

        if (result.recordset.length === 0) {
            return res.status(401).json({ success: false, error: 'PIN incorrecto' });
        }

        const empleado = result.recordset[0];
        res.json({
            success: true,
            empleado: {
                id: empleado.IdEmpleado,
                nombre: empleado.Nombre
            }
        });

    } catch (err) {
        console.error('Error login:', err);
        res.status(500).json({ success: false, error: 'Error del servidor' });
    }
});

// =============================================
// RUTAS API - MESAS (desde Clientes_Datos)
// =============================================

// Obtener todas las mesas (clientes con padre = '0002')
app.get('/api/mesas', async (req, res) => {
    try {
        const pool = await getConnection();
        console.log('Obteniendo mesas desde Clientes_Datos...');

        const result = await pool.request().query(`
            SELECT 
                c.IdCliente,
                c.cliente as nombre,
                ticket_data.IdTicket,
                ticket_data.numItems,
                ticket_data.totalTicket
            FROM Clientes_Datos c
            LEFT JOIN (
                SELECT 
                    t.IdCliente,
                    t.IdTicket,
                    COUNT(tl.IdLinea) as numItems,
                    ISNULL(SUM(tl.Total), 0) as totalTicket,
                    ROW_NUMBER() OVER (PARTITION BY t.IdCliente ORDER BY t.Fecha DESC) as rn
                FROM Tickets t
                LEFT JOIN Tickets_Lineas tl ON t.IdTicket = tl.IdTicket
                GROUP BY t.IdCliente, t.IdTicket, t.Fecha
            ) ticket_data ON c.IdCliente = ticket_data.IdCliente AND ticket_data.rn = 1
            WHERE c.padre = '0002'
              AND LOWER(c.cliente) NOT LIKE 'salon%'
            ORDER BY c.IdCliente
        `);

        const mesas = result.recordset.map(row => ({
            id: row.IdCliente,
            idCliente: row.IdCliente,
            nombre: row.nombre,
            ocupada: row.IdTicket !== null && row.numItems > 0,
            idTicket: row.IdTicket,
            numItems: row.numItems || 0,
            total: row.totalTicket || 0
        }));

        console.log('Mesas obtenidas:', mesas.length);

        res.set('Cache-Control', 'private, max-age=10');
        res.json(mesas);
    } catch (err) {
        console.error('Error al obtener mesas:', err);
        res.status(500).json({ error: 'Error al obtener mesas', details: err.message });
    }
});

// Abrir mesa - ahora solo retorna el ticket activo si existe
app.post('/api/mesas/:idCliente/abrir', async (req, res) => {
    try {
        const idCliente = req.params.idCliente;
        console.log('Abriendo mesa para cliente:', idCliente);

        const pool = await getConnection();

        const result = await pool.request()
            .input('IdCliente', sql.VarChar(50), idCliente)
            .query(`
                SELECT TOP 1 t.IdTicket, t.Fecha,
                    (SELECT COUNT(*) FROM Tickets_Lineas tl WHERE tl.IdTicket = t.IdTicket) as numItems
                FROM Tickets t
                WHERE t.IdCliente = @IdCliente
                ORDER BY t.Fecha DESC
            `);

        const ticketActivo = result.recordset[0];

        res.json({
            success: true,
            idCliente,
            idTicket: ticketActivo?.IdTicket || null,
            tieneTicket: ticketActivo && ticketActivo.numItems > 0
        });
    } catch (err) {
        console.error('Error al abrir mesa:', err);
        res.status(500).json({ error: 'Error al abrir mesa', details: err.message });
    }
});

// Obtener items de una mesa (desde BD - Tickets_Lineas)
app.get('/api/mesas/:idCliente/items', async (req, res) => {
    try {
        const idCliente = req.params.idCliente;
        console.log('Obteniendo items para cliente:', idCliente);

        const pool = await getConnection();

        const result = await pool.request()
            .input('IdCliente', sql.VarChar(50), idCliente)
            .query(`
                SELECT tl.IdArticulo as id, art.DESCRIP as nombre, tl.Cantidad as cantidad, tl.Precio as precio
                FROM Tickets t
                INNER JOIN Tickets_Lineas tl ON t.IdTicket = tl.IdTicket
                LEFT JOIN Articulos art ON tl.IdArticulo = art.IdArticulo
                WHERE t.IdCliente = @IdCliente
                  AND t.IdTicket = (SELECT TOP 1 IdTicket FROM Tickets WHERE IdCliente = @IdCliente ORDER BY Fecha DESC)
                ORDER BY tl.IdLinea ASC
            `);

        console.log('Items obtenidos desde BD:', result.recordset.length);
        res.json(result.recordset);
    } catch (err) {
        console.error('Error al obtener items:', err);
        res.status(500).json({ error: 'Error al obtener items', details: err.message });
    }
});

// =============================================
// FUNCIÓN PARA CREAR TICKET CON STORED PROCEDURE
// =============================================

async function crearTicketConSP(pool, idCliente, idEmpleado) {
    console.log('Ejecutando pTPV_Crear_Ticket_Comandas para cliente:', idCliente);

    // Construir el XML de entrada
    const xmlInput = `<data><IdCaja>${TPV_CONFIG.IdCaja}</IdCaja><IdCliente>${idCliente}</IdCliente><IdEmpleado>${idEmpleado || TPV_CONFIG.IdEmpleado || 0}</IdEmpleado><IdEmpresa>${TPV_CONFIG.IdEmpresa || 0}</IdEmpresa></data>`;

    // Ejecutar pTPV_Crear_Ticket_Comandas
    const result = await pool.request()
        .query(`
            DECLARE @oXML XML;
            EXEC pTPV_Crear_Ticket_Comandas @iXML = '${xmlInput}', @oXML = @oXML OUTPUT;
            SELECT CAST(@oXML AS NVARCHAR(MAX)) AS respuesta;
        `);

    // Verificar respuesta
    const respuesta = result.recordset[0]?.respuesta || '';
    console.log('Respuesta SP:', respuesta);

    if (respuesta.includes('<Estado>error</Estado>')) {
        throw new Error('Error al crear ticket: ' + respuesta);
    }

    // Extraer IdTicket de la respuesta XML
    const matchIdTicket = respuesta.match(/<IdTicket>(\d+)<\/IdTicket>/);
    let idTicket = matchIdTicket ? parseInt(matchIdTicket[1]) : 0;

    if (!idTicket || idTicket === 0) {
        throw new Error('No se pudo obtener el IdTicket creado');
    }

    console.log('Ticket creado con pTPV_Crear_Ticket_Comandas:', {
        IdTicket: idTicket,
        IdCaja: TPV_CONFIG.IdCaja,
        IdCliente: idCliente
    });

    return idTicket;
}

// =============================================
// Añadir item a mesa (INSERT directo en Tickets_Lineas)
// =============================================

app.post('/api/mesas/:idCliente/items', async (req, res) => {
    try {
        const idCliente = req.params.idCliente;
        const { productoId, idEmpleado, cantidad: cantidadSolicitada } = req.body;
        console.log('Agregando item a cliente:', { idCliente, productoId, idEmpleado, cantidad: cantidadSolicitada });

        const pool = await getConnection();

        // Obtener datos del artículo: precio e IVA
        const articuloResult = await pool.request()
            .input('IdArticulo', sql.VarChar(50), productoId)
            .query(`
                SELECT a.IdArticulo, a.IdIva, p.PRECIO 
                FROM Articulos a 
                LEFT JOIN VListas_Precios p ON a.IdArticulo = p.IdArticulo AND p.IdLista = 0
                WHERE a.IdArticulo = @IdArticulo
            `);

        if (articuloResult.recordset.length === 0) {
            return res.status(404).json({ error: 'Artículo no encontrado' });
        }

        const articulo = articuloResult.recordset[0];
        const precio = articulo.PRECIO || 0;
        const idIva = articulo.IdIva || 0;
        const cantidad = cantidadSolicitada || 1;
        const total = cantidad * precio;

        console.log('Datos del artículo:', { precio, idIva, cantidad, total });

        // Buscar ticket existente para este cliente
        let ticketResult = await pool.request()
            .input('IdCliente', sql.VarChar(50), idCliente)
            .query(`SELECT TOP 1 IdTicket FROM Tickets WHERE IdCliente = @IdCliente ORDER BY Fecha DESC`);

        let idTicket = ticketResult.recordset[0]?.IdTicket;

        // Si no hay ticket, crear uno nuevo usando el Stored Procedure
        if (!idTicket) {
            console.log('No hay ticket, creando uno nuevo con pTPV_Crear_Ticket_Comandas...');

            // Crear ticket usando el stored procedure con el IdEmpleado
            idTicket = await crearTicketConSP(pool, idCliente, idEmpleado);
        }

        // Obtener IdAlmacen de la caja
        const cajaResult = await pool.request()
            .input('IdCaja', sql.Int, TPV_CONFIG.IdCaja)
            .query(`SELECT IdAlmacen FROM Cajas WHERE IdCaja = @IdCaja`);
        const idAlmacen = cajaResult.recordset[0]?.IdAlmacen || 0;

        // TRANSACCIÓN para evitar condiciones de carrera al obtener IdLinea
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            // Obtener siguiente IdLinea con bloqueo (UPDLOCK) para evitar duplicados
            const maxLineaResult = await transaction.request()
                .input('IdTicket', sql.Int, idTicket)
                .query(`
                    SELECT ISNULL(MAX(IdLinea), 0) + 1 as nextLinea 
                    FROM Tickets_Lineas WITH (UPDLOCK, HOLDLOCK)
                    WHERE IdTicket = @IdTicket
                `);
            const idLinea = maxLineaResult.recordset[0].nextLinea;

            // INSERT directo en Tickets_Lineas
            await transaction.request()
                .input('IdTicket', sql.Int, idTicket)
                .input('IdLinea', sql.SmallInt, idLinea)
                .input('IdArticulo', sql.VarChar(50), productoId)
                .input('IdAlmacen', sql.SmallInt, idAlmacen)
                .input('Cantidad', sql.Decimal(18, 6), cantidad)
                .input('Precio', sql.Decimal(18, 6), precio)
                .input('PorcDesc', sql.Decimal(18, 6), 0)
                .input('Descuento', sql.Decimal(18, 6), 0)
                .input('IdIVA', sql.SmallInt, idIva)
                .input('Total', sql.Decimal(18, 6), total)
                .input('Usuario', sql.VarChar(50), 'COMANDAS')
                .input('fechaini', sql.DateTime, null)
                .input('fechadev', sql.DateTime, null)
                .input('tipoalquiler', sql.SmallInt, null)
                .input('idlinea_abono', sql.Int, null)
                .input('idlinea_oferta', sql.Int, null)
                .query(`
                    INSERT INTO Tickets_Lineas (IdTicket, IdLinea, IdArticulo, IdAlmacen, Cantidad, Precio, PorcDesc, Descuento, IdIVA, Total, Usuario, fechaini, fechadev, tipoalquiler, idlinea_abono, idlinea_oferta)
                    VALUES (@IdTicket, @IdLinea, @IdArticulo, @IdAlmacen, @Cantidad, @Precio, @PorcDesc, @Descuento, @IdIVA, @Total, @Usuario, @fechaini, @fechadev, @tipoalquiler, @idlinea_abono, @idlinea_oferta)
                `);

            await transaction.commit();

            console.log('Línea insertada:', { idTicket, idLinea, productoId, precio, total });

        } catch (txErr) {
            await transaction.rollback();
            throw txErr;
        }

        // Obtener nuevo total del ticket
        const totalResult = await pool.request()
            .input('IdTicket', sql.Int, idTicket)
            .query(`SELECT ISNULL(SUM(Total), 0) as total FROM Tickets_Lineas WHERE IdTicket = @IdTicket`);

        console.log('Item agregado');
        res.json({ success: true, total: totalResult.recordset[0].total, idTicket });

        // Notificar a todos los clientes WebSocket
        notificarClientes('mesa_actualizada', { idCliente });

    } catch (err) {
        console.error('Error al agregar item:', err);
        res.status(500).json({ error: 'Error al agregar item', details: err.message });
    }
});

// Actualizar cantidad de un item
app.put('/api/mesas/:idCliente/items/:itemId/cantidad', async (req, res) => {
    try {
        const idCliente = req.params.idCliente;
        const itemId = req.params.itemId;
        const { cantidad } = req.body;
        console.log('Actualizando cantidad del item:', { idCliente, itemId, cantidad });

        const pool = await getConnection();

        // Buscar ticket activo para este cliente
        const ticketResult = await pool.request()
            .input('IdCliente', sql.VarChar(50), idCliente)
            .query(`SELECT TOP 1 IdTicket FROM Tickets WHERE IdCliente = @IdCliente ORDER BY Fecha DESC`);

        const idTicket = ticketResult.recordset[0]?.IdTicket;

        if (idTicket) {
            // Buscar la línea del artículo por su ID
            const lineaResult = await pool.request()
                .input('IdTicket', sql.Int, idTicket)
                .input('IdArticulo', sql.VarChar(50), itemId)
                .query(`SELECT IdLinea, Precio FROM Tickets_Lineas WHERE IdTicket = @IdTicket AND IdArticulo = @IdArticulo`);

            if (lineaResult.recordset.length > 0) {
                const linea = lineaResult.recordset[0];
                const nuevoTotal = cantidad * linea.Precio;

                // Actualizar cantidad y total
                await pool.request()
                    .input('IdTicket', sql.Int, idTicket)
                    .input('IdArticulo', sql.VarChar(50), itemId)
                    .input('Cantidad', sql.Decimal(18, 6), cantidad)
                    .input('Total', sql.Decimal(18, 6), nuevoTotal)
                    .query(`UPDATE Tickets_Lineas SET Cantidad = @Cantidad, Total = @Total WHERE IdTicket = @IdTicket AND IdArticulo = @IdArticulo`);

                console.log('Cantidad actualizada:', { cantidad, nuevoTotal });
            }
        }

        res.json({ success: true });

        // Notificar a todos los clientes WebSocket
        notificarClientes('mesa_actualizada', { idCliente });

    } catch (err) {
        console.error('Error al actualizar cantidad:', err);
        res.status(500).json({ error: 'Error al actualizar cantidad', details: err.message });
    }
});

// Eliminar item de mesa (en BD - Tickets_Lineas)
app.delete('/api/mesas/:idCliente/items/:productoId', async (req, res) => {
    try {
        const idCliente = req.params.idCliente;
        const productoId = req.params.productoId;
        console.log('Eliminando item:', { idCliente, productoId });

        const pool = await getConnection();

        // Buscar ticket activo para este cliente
        const ticketResult = await pool.request()
            .input('IdCliente', sql.VarChar(50), idCliente)
            .query(`SELECT TOP 1 IdTicket FROM Tickets WHERE IdCliente = @IdCliente ORDER BY Fecha DESC`);

        const idTicket = ticketResult.recordset[0]?.IdTicket;

        if (idTicket) {
            // Buscar la línea del artículo
            const lineaResult = await pool.request()
                .input('IdTicket', sql.Int, idTicket)
                .input('IdArticulo', sql.VarChar(50), productoId)
                .query(`SELECT IdLinea, Cantidad, Precio FROM Tickets_Lineas WHERE IdTicket = @IdTicket AND IdArticulo = @IdArticulo`);

            if (lineaResult.recordset.length > 0) {
                const linea = lineaResult.recordset[0];
                if (linea.Cantidad > 1) {
                    // Reducir cantidad
                    const nuevaCantidad = linea.Cantidad - 1;
                    const nuevoTotal = nuevaCantidad * linea.Precio;
                    await pool.request()
                        .input('IdTicket', sql.Int, idTicket)
                        .input('IdArticulo', sql.VarChar(50), productoId)
                        .input('Cantidad', sql.Decimal(10, 2), nuevaCantidad)
                        .input('Total', sql.Decimal(10, 2), nuevoTotal)
                        .query(`UPDATE Tickets_Lineas SET Cantidad = @Cantidad, Total = @Total WHERE IdTicket = @IdTicket AND IdArticulo = @IdArticulo`);
                    console.log('Cantidad reducida');
                } else {
                    // Eliminar línea
                    await pool.request()
                        .input('IdTicket', sql.Int, idTicket)
                        .input('IdArticulo', sql.VarChar(50), productoId)
                        .query(`DELETE FROM Tickets_Lineas WHERE IdTicket = @IdTicket AND IdArticulo = @IdArticulo`);
                    console.log('Línea eliminada');
                }
            }
        }

        console.log('Item eliminado');
        res.json({ success: true });

        // Notificar a todos los clientes WebSocket
        notificarClientes('mesa_actualizada', { idCliente });

    } catch (err) {
        console.error('Error al eliminar item:', err);
        res.status(500).json({ error: 'Error al eliminar item', details: err.message });
    }
});

// Limpiar mesa (eliminar ticket y sus líneas de la BD)
app.post('/api/mesas/:idCliente/cerrar', async (req, res) => {
    try {
        const idCliente = req.params.idCliente;
        console.log('Cerrando mesa:', idCliente);

        const pool = await getConnection();

        // Buscar ticket activo para este cliente
        const ticketResult = await pool.request()
            .input('IdCliente', sql.VarChar(50), idCliente)
            .query(`SELECT TOP 1 IdTicket FROM Tickets WHERE IdCliente = @IdCliente ORDER BY Fecha DESC`);

        const idTicket = ticketResult.recordset[0]?.IdTicket;

        if (idTicket) {
            // Eliminar líneas primero
            await pool.request()
                .input('IdTicket', sql.Int, idTicket)
                .query(`DELETE FROM Tickets_Lineas WHERE IdTicket = @IdTicket`);

            // Eliminar ticket
            await pool.request()
                .input('IdTicket', sql.Int, idTicket)
                .query(`DELETE FROM Tickets WHERE IdTicket = @IdTicket`);

            console.log('Ticket y líneas eliminados');
        }

        console.log('Mesa cerrada exitosamente');
        res.json({ success: true });

        // Notificar a todos los clientes WebSocket
        notificarClientes('mesa_actualizada', { idCliente });

    } catch (err) {
        console.error('Error al cerrar mesa:', err);
        res.status(500).json({ error: 'Error al cerrar mesa', details: err.message });
    }
});

// =============================================
// RUTAS API - ARTÍCULOS
// =============================================

app.get('/api/articulos', async (req, res) => {
    try {
        const pool = await getConnection();
        console.log('Obteniendo artículos...');

        const result = await pool.request().query(`
            SELECT
                a.iDaRTICULO,
                art.DESCRIP,
                a.DESCRIPFAMILIA,
                P.PRECIO
            FROM pers_OrdenArticulosTPV a
            LEFT JOIN Articulos art ON a.iDaRTICULO = art.IdArticulo
            LEFT JOIN VListas_Precios p ON a.iDaRTICULO = p.idarticulo
            WHERE IDCAJA = ${TPV_CONFIG.IdCaja} AND IdLista = 0
            ORDER BY a.DESCRIPFAMILIA, art.DESCRIP
        `);

        console.log('Artículos obtenidos:', result.recordset.length);
        res.json(result.recordset);
    } catch (err) {
        console.error('Error al obtener artículos:', err);
        res.status(500).json({ error: 'Error al obtener artículos', details: err.message });
    }
});

// Obtener productos favoritos
app.get('/api/favoritos', async (req, res) => {
    try {
        const pool = await getConnection();
        console.log('🌟 Obteniendo productos favoritos...');
        console.log('🌟 IdCaja configurado:', TPV_CONFIG.IdCaja);

        // Primero verificar que existen favoritos
        const testQuery = await pool.request().query(`
            SELECT COUNT(*) as total FROM TPV_Cajas_Favoritos_Asociados WHERE IdCaja = ${TPV_CONFIG.IdCaja}
        `);
        console.log('🌟 Total favoritos en tabla:', testQuery.recordset[0].total);

        // Consulta principal con LEFT JOIN para diagnóstico
        const result = await pool.request().query(`
            SELECT
                f.IdArticulo,
                a.iDaRTICULO,
                art.DESCRIP,
                a.DESCRIPFAMILIA,
                P.PRECIO
            FROM TPV_Cajas_Favoritos_Asociados f
            LEFT JOIN pers_OrdenArticulosTPV a ON f.IdArticulo = a.iDaRTICULO AND a.IDCAJA = ${TPV_CONFIG.IdCaja}
            LEFT JOIN Articulos art ON f.IdArticulo = art.IdArticulo
            LEFT JOIN VListas_Precios p ON a.iDaRTICULO = p.idarticulo AND p.IdLista = 0
            WHERE f.IdCaja = ${TPV_CONFIG.IdCaja}
            ORDER BY art.DESCRIP
        `);

        console.log('🌟 Productos favoritos obtenidos:', result.recordset.length);
        if (result.recordset.length > 0) {
            console.log('🌟 Primeros 3 favoritos (raw):', result.recordset.slice(0, 3));
        } else {
            console.log('⚠️ No se encontraron favoritos. Verificando tabla...');
            // Consulta de diagnóstico
            const diagnostico = await pool.request().query(`
                SELECT COUNT(*) as total FROM TPV_Cajas_Favoritos_Asociados WHERE IdCaja = ${TPV_CONFIG.IdCaja}
            `);
            console.log('⚠️ Total de favoritos en la tabla para IdCaja ${TPV_CONFIG.IdCaja}:', diagnostico.recordset[0].total);
        }

        // Filtrar los que tienen precio (que se encontraron en las otras tablas)
        const favoritosValidos = result.recordset.filter(item => item.PRECIO != null);
        console.log('🌟 Favoritos válidos con precio:', favoritosValidos.length);

        res.json(favoritosValidos);
    } catch (err) {
        console.error('❌ Error al obtener favoritos:', err);
        res.status(500).json({ error: 'Error al obtener favoritos', details: err.message });
    }
});


// =============================================
// RUTAS API - TICKETS (crear en tablas TPV)
// =============================================

// Ruta temporal para debug - ver estructura de tickets
app.get('/api/tickets/debug', async (req, res) => {
    try {
        const pool = await getConnection();

        const columnsResult = await pool.request().query(`
            SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'Tickets'
            ORDER BY ORDINAL_POSITION
        `);

        const exampleResult = await pool.request().query(`
            SELECT TOP 1 * FROM Tickets ORDER BY IdTicket DESC
        `);

        res.json({
            columns: columnsResult.recordset,
            example: exampleResult.recordset[0] || null
        });
    } catch (err) {
        console.error('Error debug:', err);
        res.status(500).json({ error: err.message });
    }
});

// Ruta temporal para debug - ver estructura de Tickets_Lineas
app.get('/api/tickets_lineas/debug', async (req, res) => {
    try {
        const pool = await getConnection();

        const columnsResult = await pool.request().query(`
            SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = 'Tickets_Lineas'
            ORDER BY ORDINAL_POSITION
        `);

        const exampleResult = await pool.request().query(`
            SELECT TOP 1 * FROM Tickets_Lineas ORDER BY IdTicket DESC
        `);

        res.json({
            columns: columnsResult.recordset,
            example: exampleResult.recordset[0] || null
        });
    } catch (err) {
        console.error('Error debug:', err);
        res.status(500).json({ error: err.message });
    }
});

// Ruta temporal para debug - ver empleados
app.get('/api/empleados/debug', async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().query(`
            SELECT TOP 10 IdEmpleado, Empleado FROM Empleados_Datos ORDER BY IdEmpleado
        `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tickets', async (req, res) => {
    console.log('=== CREANDO TICKET EN TPV ===');
    console.log('Body:', req.body);

    const idCliente = String(req.body.idCliente);
    console.log('idCliente:', idCliente);

    const pool = await getConnection();

    try {
        // Buscar ticket existente para este cliente con sus items
        const ticketResult = await pool.request()
            .input('IdCliente', sql.VarChar(50), idCliente)
            .query(`SELECT TOP 1 IdTicket FROM Tickets WHERE IdCliente = @IdCliente ORDER BY Fecha DESC`);

        const idTicketExistente = ticketResult.recordset[0]?.IdTicket;

        if (!idTicketExistente) {
            console.log('ERROR: No hay ticket para este cliente');
            return res.status(400).json({ error: 'No hay ticket para este cliente' });
        }

        // Obtener los items del ticket desde la BD
        const itemsResult = await pool.request()
            .input('IdTicket', sql.Int, idTicketExistente)
            .query(`
                SELECT IdArticulo as id, Cantidad as cantidad, Precio as precio, Total as total
                FROM Tickets_Lineas
                WHERE IdTicket = @IdTicket
            `);

        const items = itemsResult.recordset;
        console.log('Items encontrados en BD:', items.length);

        if (items.length === 0) {
            console.log('ERROR: No hay items en el ticket');
            return res.status(400).json({ error: 'No hay items en el pedido' });
        }

        // Calcular el total
        const totalPedido = items.reduce((sum, item) => sum + parseFloat(item.total), 0);

        console.log('=== TICKET YA EXISTE EN TPV ===');
        console.log('IdTicket:', idTicketExistente, 'Total:', totalPedido);

        res.json({
            success: true,
            IdTicket: idTicketExistente,
            Total: totalPedido
        });

    } catch (err) {
        console.error('ERROR PROCESANDO TICKET:', err);
        res.status(500).json({ error: 'Error al procesar el ticket', details: err.message });
    }
});

// =============================================
// SERVIR APLICACIÓN
// =============================================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// =============================================
// INICIAR SERVIDOR HTTPS/HTTP + WEBSOCKET
// =============================================

const HOST = '0.0.0.0';

let server;
const sslKeyPath = path.join(__dirname, 'ssl', 'server.key');
const sslCertPath = path.join(__dirname, 'ssl', 'server.cert');
const sslPfxPath = path.join(__dirname, 'ssl', 'server.pfx');

if (fs.existsSync(sslPfxPath)) {
    const httpsOptions = {
        pfx: fs.readFileSync(sslPfxPath),
        passphrase: 'desarrollo'
    };

    server = https.createServer(httpsOptions, app);
    server.listen(port, HOST, () => {
        console.log(`🔐 Servidor HTTPS corriendo en https://localhost:${port}`);
        console.log(`⚠️  Certificado autofirmado - el navegador mostrará advertencia de seguridad`);

        getConnection()
            .then(() => console.log('✅ Conexión a la base de datos establecida correctamente'))
            .catch(err => console.error('❌ Error al conectar con la base de datos:', err));
    });
} else if (fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath)) {
    const httpsOptions = {
        key: fs.readFileSync(sslKeyPath),
        cert: fs.readFileSync(sslCertPath)
    };

    server = https.createServer(httpsOptions, app);
    server.listen(port, HOST, () => {
        console.log(`🔐 Servidor HTTPS corriendo en https://localhost:${port}`);
        console.log(`⚠️  Certificado autofirmado - el navegador mostrará advertencia de seguridad`);

        getConnection()
            .then(() => console.log('✅ Conexión a la base de datos establecida correctamente'))
            .catch(err => console.error('❌ Error al conectar con la base de datos:', err));
    });
} else {
    server = http.createServer(app);
    server.listen(port, HOST, () => {
        console.log(`🚀 Servidor HTTP corriendo en http://localhost:${port}`);
        console.log(`💡 Para usar HTTPS, ejecuta: .\\generate-ssl.ps1`);

        getConnection()
            .then(() => console.log('✅ Conexión a la base de datos establecida correctamente'))
            .catch(err => console.error('❌ Error al conectar con la base de datos:', err));
    });
}

// Iniciar WebSocket Server
const wss = new WebSocket.Server({ server });

let clientes = [];

wss.on('connection', (ws) => {
    console.log('🔌 Cliente WebSocket conectado');
    clientes.push(ws);

    ws.on('close', () => {
        console.log('🔌 Cliente WebSocket desconectado');
        clientes = clientes.filter(c => c !== ws);
    });

    ws.on('error', (error) => {
        console.error('❌ Error WebSocket:', error);
    });
});

// Función para notificar a todos los clientes
function notificarClientes(tipo, datos = {}) {
    const mensaje = JSON.stringify({ tipo, ...datos });
    console.log(`📢 Notificando a ${clientes.length} clientes:`, mensaje);
    clientes.forEach(cliente => {
        if (cliente.readyState === WebSocket.OPEN) {
            cliente.send(mensaje);
        }
    });
}

console.log('✅ WebSocket Server iniciado');