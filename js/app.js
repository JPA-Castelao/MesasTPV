// Configuración
const API_BASE = '/api';

// Estado de la aplicación
let mesaActual = null;
let modoEdicion = false;
let productos = [];
let filtroActual = 'all';
let vistaActual = 'grid';

// Estado de las mesas (cliente)
let mesas = {};
let mesasOrden = []; // Orden de las mesas para drag & drop
let mesasEnUso = {}; // Mesas en uso por empleados

// Elementos del DOM
const mesasContainer = document.getElementById('mesas-container');
const modalMesa = document.getElementById('modal-mesa');
const numeroMesaSpan = document.getElementById('numero-mesa');
const productosDisponibles = document.getElementById('productos-disponibles');
const itemsPedido = document.getElementById('items-pedido');
const totalPedido = document.getElementById('total-pedido');
const closeBtn = document.querySelector('.close');
const toggleEditBtn = document.getElementById('toggle-edit');
const addMesaBtn = document.getElementById('add-mesa');

// =============================================
// LOGIN / AUTENTICACIÓN
// =============================================

let empleadoActual = null;
let pinIngresado = '';
let empleadoSeleccionado = null;

// =============================================
// WEBSOCKET
// =============================================

let ws = null;

function conectarWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    console.log('🔌 Conectando WebSocket a:', wsUrl);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('✅ WebSocket conectado');
    };

    ws.onmessage = (evento) => {
        const datos = JSON.parse(evento.data);
        console.log('📩 WebSocket mensaje:', datos);

        if (datos.tipo === 'mesa_actualizada') {
            cargarMesas();
        } else if (datos.tipo === 'mesa_en_uso') {
            mesasEnUso[datos.idCliente] = {
                idEmpleado: datos.idEmpleado,
                nombre: datos.empleado
            };
            actualizarEstadoMesaEnUso(datos.idCliente);
        } else if (datos.tipo === 'mesa_liberada') {
            delete mesasEnUso[datos.idCliente];
            actualizarEstadoMesaEnUso(datos.idCliente);
        }
    };

    ws.onclose = () => {
        console.log('❌ WebSocket desconectado, reconectando en 3s...');
        setTimeout(conectarWebSocket, 3000);
    };

    ws.onerror = (error) => {
        console.error('❌ WebSocket error:', error);
    };
}

// =============================================
// MESAS EN USO
// =============================================

async function cargarMesasEnUso() {
    try {
        const response = await fetch(`${API_BASE}/mesas/en-uso`);
        mesasEnUso = await response.json();

        // Actualizar todas las mesas
        Object.keys(mesasEnUso).forEach(idCliente => {
            actualizarEstadoMesaEnUso(idCliente);
        });
    } catch (error) {
        console.error('Error cargando mesas en uso:', error);
    }
}

function actualizarEstadoMesaEnUso(idCliente) {
    const mesaElement = document.querySelector(`.mesa[data-id-cliente="${idCliente}"]`);
    if (!mesaElement) return;

    const enUso = mesasEnUso[idCliente];
    const esMia = enUso && enUso.idEmpleado === empleadoActual?.id;

    mesaElement.classList.remove('en-uso', 'mi-uso');

    if (enUso) {
        if (esMia) {
            mesaElement.classList.add('mi-uso');
            mesaElement.querySelector('.mesa-estado').textContent = 'En uso (tú)';
        } else {
            mesaElement.classList.add('en-uso');
            mesaElement.querySelector('.mesa-estado').textContent = `${enUso.nombre}`;
        }
    } else {
        // Restaurar estado original
        const mesa = mesas[idCliente];
        if (mesa) {
            mesaElement.querySelector('.mesa-estado').textContent = mesa.ocupada ? `${mesa.total.toFixed(2)}€` : 'Libre';
        }
    }
}

// =============================================
// FUNCIONES DE LOGIN
// =============================================

async function verificarSesion() {
    const sesion = sessionStorage.getItem('empleado');

    if (sesion) {
        empleadoActual = JSON.parse(sesion);
        ocultarLogin();
        return true;
    }

    mostrarLogin();
    return false;
}

function mostrarLogin() {
    document.getElementById('login-screen').classList.remove('hidden');
    cargarEmpleados();
}

function ocultarLogin() {
    document.getElementById('login-screen').classList.add('hidden');
}

async function cargarEmpleados() {
    try {
        // Intentar cargar desde caché primero
        const cacheKey = 'empleados_cache';
        const cacheTTL = 60 * 60 * 1000; // 1 hora
        const cached = localStorage.getItem(cacheKey);
        const cacheTime = localStorage.getItem(cacheKey + '_time');

        let empleados;

        if (cached && cacheTime && (Date.now() - parseInt(cacheTime)) < cacheTTL) {
            console.log('✅ Usando empleados desde caché');
            empleados = JSON.parse(cached);
        } else {
            console.log('⬇️ Descargando empleados desde servidor');
            const response = await fetch(`${API_BASE}/empleados`);
            if (!response.ok) throw new Error('Error al cargar empleados');

            empleados = await response.json();

            // Guardar en caché
            localStorage.setItem(cacheKey, JSON.stringify(empleados));
            localStorage.setItem(cacheKey + '_time', Date.now().toString());
        }

        const grid = document.getElementById('empleados-grid');
        grid.innerHTML = '';

        empleados.forEach(emp => {
            const card = document.createElement('div');
            card.className = 'empleado-card';
            card.innerHTML = `
                <span class="empleado-avatar">👤</span>
                <span class="empleado-nombre">${emp.Nombre}</span>
            `;
            card.addEventListener('click', () => seleccionarEmpleado(emp));
            grid.appendChild(card);
        });

    } catch (error) {
        console.error('Error cargando empleados:', error);
    }
}

function seleccionarEmpleado(empleado) {
    empleadoSeleccionado = empleado;
    pinIngresado = '';

    document.getElementById('nombre-seleccionado').textContent = empleado.Nombre;
    document.getElementById('login-step-1').classList.add('hidden');
    document.getElementById('login-step-2').classList.remove('hidden');
    document.getElementById('pin-error').classList.add('hidden');

    actualizarPinDots();
}

function volverASeleccion() {
    empleadoSeleccionado = null;
    pinIngresado = '';

    document.getElementById('login-step-1').classList.remove('hidden');
    document.getElementById('login-step-2').classList.add('hidden');
}

function agregarDigito(num) {
    if (pinIngresado.length < 4) {
        pinIngresado += num;
        actualizarPinDots();
        document.getElementById('pin-error').classList.add('hidden');

        // Auto-submit cuando tenga 4 dígitos
        if (pinIngresado.length === 4) {
            setTimeout(() => validarPin(), 200);
        }
    }
}

function borrarDigito() {
    pinIngresado = pinIngresado.slice(0, -1);
    actualizarPinDots();
    document.getElementById('pin-error').classList.add('hidden');
}

function actualizarPinDots() {
    const dots = document.querySelectorAll('.pin-dot');
    dots.forEach((dot, index) => {
        dot.classList.toggle('filled', index < pinIngresado.length);
    });
}

async function validarPin() {
    if (!empleadoSeleccionado || pinIngresado.length === 0) return;

    try {
        const response = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                idEmpleado: empleadoSeleccionado.IdEmpleado,
                pin: pinIngresado
            })
        });

        const data = await response.json();

        if (data.success) {
            empleadoActual = data.empleado;
            sessionStorage.setItem('empleado', JSON.stringify(data.empleado));
            ocultarLogin();

            // Activar pantalla completa
            toggleFullScreen();

            // Actualizar nombre del empleado en la UI
            actualizarEmpleadoActual();

            // Iniciar la app
            await cargarProductos();
            await cargarMesas();
            await cargarProductosFavoritos();
            await cargarMesasEnUso();

            // Conectar WebSocket
            conectarWebSocket();
        } else {
            document.getElementById('pin-error').classList.remove('hidden');
            pinIngresado = '';
            actualizarPinDots();
        }

    } catch (error) {
        console.error('Error validando PIN:', error);
        document.getElementById('pin-error').textContent = 'Error de conexión';
        document.getElementById('pin-error').classList.remove('hidden');
    }
}

function configurarLoginEventos() {
    // Botón volver
    document.getElementById('btn-volver').addEventListener('click', volverASeleccion);

    // Teclado numérico
    document.querySelectorAll('.pin-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const num = btn.dataset.num;
            const action = btn.dataset.action;

            if (num !== undefined) {
                agregarDigito(num);
            } else if (action === 'clear') {
                borrarDigito();
            } else if (action === 'enter') {
                validarPin();
            }
        });
    });

    // Teclado físico
    document.addEventListener('keydown', (e) => {
        if (document.getElementById('login-screen').classList.contains('hidden')) return;
        if (document.getElementById('login-step-2').classList.contains('hidden')) return;

        if (e.key >= '0' && e.key <= '9') {
            agregarDigito(e.key);
        } else if (e.key === 'Backspace') {
            borrarDigito();
        } else if (e.key === 'Enter') {
            validarPin();
        } else if (e.key === 'Escape') {
            volverASeleccion();
        }
    });
}

// =============================================
// FUNCIONES DE EMPLEADO ACTUAL
// =============================================

function actualizarEmpleadoActual() {
    const employeeNameElement = document.getElementById('current-employee-name');
    if (employeeNameElement && empleadoActual) {
        employeeNameElement.textContent = empleadoActual.nombre || empleadoActual.Nombre || '-';
    }
}

// =============================================
// FUNCIONES DE VISTA
// =============================================

function configurarVistas() {
    const viewBtns = document.querySelectorAll('.view-btn');
    viewBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            viewBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            vistaActual = btn.dataset.view;
            aplicarVista();
        });
    });
}

function aplicarVista() {
    if (vistaActual === 'list') {
        document.querySelectorAll('.mesa').forEach(m => m.setAttribute('draggable', 'false'));
        mesasContainer.classList.add('list-view');
    } else {
        mesasContainer.classList.remove('list-view');
    }
}

// =============================================
// BÚSQUEDA DE PRODUCTOS
// =============================================

function configurarBusquedaProductos() {
    const searchInput = document.getElementById('search-input');
    const btnLimpiar = document.getElementById('btn-limpiar-busqueda');

    if (!searchInput || !btnLimpiar) return;

    // Búsqueda en tiempo real
    searchInput.addEventListener('input', (e) => {
        const termino = e.target.value;

        // Si el usuario empieza a buscar, desactivar modo favoritos
        if (termino.trim() && mostrandoFavoritos) {
            const btnFavoritos = document.getElementById('btn-favoritos');
            if (btnFavoritos) {
                btnFavoritos.classList.remove('active');
                mostrandoFavoritos = false;
            }
        }

        mostrarProductos(termino);

        // Mostrar/ocultar botón de limpiar
        if (termino.trim()) {
            btnLimpiar.classList.add('visible');
            btnLimpiar.style.display = 'flex';
        } else {
            btnLimpiar.classList.remove('visible');
            btnLimpiar.style.display = 'none';
        }
    });

    // Limpiar búsqueda
    btnLimpiar.addEventListener('click', () => {
        searchInput.value = '';
        mostrarProductos();
        btnLimpiar.classList.remove('visible');
        btnLimpiar.style.display = 'none';
        searchInput.focus();
    });

    // Limpiar al presionar Escape
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            searchInput.value = '';
            mostrarProductos();
            btnLimpiar.classList.remove('visible');
            btnLimpiar.style.display = 'none';
            searchInput.blur();
        }
    });
}

// =============================================
// MODAL TICKET (ABRIR/CERRAR)
// =============================================

function configurarTogglePedido() {
    const toggleBtn = document.getElementById('toggle-pedido');
    const modalTicket = document.getElementById('modal-ticket');
    const closeTicketBtn = document.querySelector('.close-ticket');

    if (!toggleBtn || !modalTicket) return;

    // Abrir modal de ticket
    toggleBtn.addEventListener('click', abrirModalTicket);

    // Cerrar modal de ticket
    if (closeTicketBtn) {
        closeTicketBtn.addEventListener('click', cerrarModalTicket);
    }

    // Cerrar al hacer click fuera del modal
    window.addEventListener('click', (e) => {
        if (e.target === modalTicket) {
            cerrarModalTicket();
        }
    });
}

async function abrirModalTicket() {
    if (!mesaActual) return;

    try {
        // Recargar items desde la BD para asegurar que estén actualizados
        const itemsResponse = await fetch(`${API_BASE}/mesas/${mesaActual}/items`);
        const items = await itemsResponse.json();

        // Actualizar el estado local con los items más recientes
        const mesa = mesas[mesaActual];
        mesa.items = items;
        mesa.total = items.reduce((sum, item) => sum + (item.precio * item.cantidad), 0);

        const modalTicket = document.getElementById('modal-ticket');
        const ticketNumeroMesa = document.getElementById('ticket-numero-mesa');
        const ticketItemsLista = document.getElementById('ticket-items-lista');
        const ticketTotal = document.getElementById('ticket-total');

        // Actualizar título
        ticketNumeroMesa.textContent = mesa.nombre;

        // Limpiar y renderizar items
        ticketItemsLista.innerHTML = '';
        let total = 0;

        mesa.items.forEach((item) => {
            const subtotal = item.precio * item.cantidad;
            total += subtotal;

            const itemElement = document.createElement('div');
            itemElement.className = 'item-pedido';
            itemElement.innerHTML = `
                <div class="item-info">
                    <span class="item-nombre">${item.nombre}</span>
                    <span class="item-cantidad">x${item.cantidad}</span>
                </div>
                <div class="item-precios">
                    <span class="item-subtotal">${subtotal.toFixed(2)}€</span>
                    <button class="btn btn-eliminar" data-id="${item.id}">Eliminar</button>
                </div>
            `;

            itemElement.querySelector('.btn-eliminar').addEventListener('click', async () => {
                await eliminarItem(item.id);
                // Actualizar el modal después de eliminar
                abrirModalTicket();
            });

            ticketItemsLista.appendChild(itemElement);
        });

        ticketTotal.textContent = total.toFixed(2);

        // Mostrar modal
        modalTicket.style.display = 'block';
    } catch (error) {
        console.error('Error al abrir modal del ticket:', error);
        alert('Error al cargar el ticket');
    }
}

function cerrarModalTicket() {
    const modalTicket = document.getElementById('modal-ticket');
    modalTicket.style.display = 'none';
}

// =============================================
// FAVORITOS
// =============================================

let productosFavoritos = [];
let mostrandoFavoritos = false;

async function cargarProductosFavoritos() {
    try {
        console.log('⭐ Cargando productos favoritos...');
        const response = await fetch(`${API_BASE}/favoritos`);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        console.log('⭐ Favoritos recibidos de API:', data.length, data);

        productosFavoritos = data.map(item => ({
            id: item.iDaRTICULO || item.IdArticulo,
            nombre: item.DESCRIP,
            precio: parseFloat(item.PRECIO) || 0,
            categoria: item.DESCRIPFAMILIA
        }));

        console.log('⭐ Favoritos procesados:', productosFavoritos.length, productosFavoritos);
    } catch (error) {
        console.error('❌ Error al cargar productos favoritos:', error);
        productosFavoritos = [];
    }
}

function configurarBotonFavoritos() {
    console.log('🔧 Configurando botón de favoritos...');
    const btnFavoritos = document.getElementById('btn-favoritos');
    console.log('🔧 Botón encontrado:', btnFavoritos);

    if (!btnFavoritos) {
        console.error('❌ No se encontró el botón btn-favoritos');
        return;
    }

    btnFavoritos.addEventListener('click', () => {
        console.log('⭐ Click en botón favoritos!');
        toggleFavoritos();
    });

    console.log('✅ Event listener agregado al botón favoritos');
}

function toggleFavoritos() {
    console.log('⭐ toggleFavoritos llamado. Estado actual:', mostrandoFavoritos);
    const btnFavoritos = document.getElementById('btn-favoritos');
    mostrandoFavoritos = !mostrandoFavoritos;

    console.log('⭐ Nuevo estado:', mostrandoFavoritos);
    console.log('⭐ Favoritos disponibles:', productosFavoritos.length);

    if (mostrandoFavoritos) {
        btnFavoritos.classList.add('active');
        mostrarProductosFavoritos();
    } else {
        btnFavoritos.classList.remove('active');
        mostrarProductos(); // Mostrar todos los productos
    }
}

function mostrarProductosFavoritos() {
    console.log('⭐ mostrarProductosFavoritos llamado');
    console.log('⭐ productosFavoritos:', productosFavoritos);
    console.log('⭐ productosDisponibles element:', productosDisponibles);
    console.log('⭐ Mostrando productos favoritos. Total:', productosFavoritos.length);
    productosDisponibles.innerHTML = '';

    if (productosFavoritos.length === 0) {
        productosDisponibles.innerHTML = `
            <div style="padding: 2rem; text-align: center; color: #999;">
                <p style="font-size: 2rem; margin-bottom: 0.5rem;">⭐</p>
                <p>No hay productos favoritos configurados</p>
            </div>
        `;
        return;
    }

    // Mostrar favoritos sin agrupar por categoría
    productosFavoritos.forEach(producto => {
        const productoElement = document.createElement('div');
        productoElement.className = 'producto producto-favorito';
        productoElement.innerHTML = `
            <span class="producto-star">⭐</span>
            <div class="producto-nombre">${producto.nombre}</div>
            <div class="producto-precio">${producto.precio.toFixed(2)}€</div>
        `;
        productoElement.addEventListener('click', () => agregarProducto(producto));
        productosDisponibles.appendChild(productoElement);
    });

    console.log('✅ Productos favoritos renderizados');
}


// =============================================
// FUNCIONES DE ORDEN (DRAG & DROP)
// =============================================

function cargarOrdenMesas() {
    try {
        const orden = localStorage.getItem('mesasOrden');
        if (orden) {
            mesasOrden = JSON.parse(orden);
            console.log('Orden de mesas cargado:', mesasOrden);
        }
    } catch (e) {
        console.error('Error al cargar orden de mesas:', e);
        mesasOrden = [];
    }
}

function guardarOrdenMesas() {
    try {
        const mesasElements = document.querySelectorAll('.mesa');
        mesasOrden = Array.from(mesasElements).map(el => parseInt(el.dataset.idCliente));
        localStorage.setItem('mesasOrden', JSON.stringify(mesasOrden));
        console.log('Orden de mesas guardado:', mesasOrden);
    } catch (e) {
        console.error('Error al guardar orden de mesas:', e);
    }
}

function ordenarMesasPorOrdenGuardado(mesasArray) {
    return mesasArray.sort((a, b) => {
        const esParaLlevarA = a.nombre.toUpperCase() === 'PARA LLEVAR';
        const esParaLlevarB = b.nombre.toUpperCase() === 'PARA LLEVAR';

        if (esParaLlevarA && !esParaLlevarB) return 1;
        if (!esParaLlevarA && esParaLlevarB) return -1;

        if (mesasOrden.length > 0) {
            const indexA = mesasOrden.indexOf(a.idCliente);
            const indexB = mesasOrden.indexOf(b.idCliente);

            if (indexA !== -1 && indexB !== -1) {
                return indexA - indexB;
            }

            if (indexA !== -1) return -1;
            if (indexB !== -1) return 1;
        }

        return 0;
    });
}

// =============================================
// FUNCIONES DE API
// =============================================

async function cargarMesas() {
    try {
        console.log('Cargando mesas desde clientes...');
        const response = await fetch(`${API_BASE}/mesas`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const data = await response.json();
        console.log('Mesas cargadas:', data);

        cargarOrdenMesas();

        mesas = {};
        mesasContainer.innerHTML = '';

        data.forEach(mesa => {
            mesas[mesa.idCliente] = {
                idCliente: mesa.idCliente,
                codigo: mesa.codigo,
                nombre: mesa.nombre,
                ocupada: mesa.ocupada,
                items: mesa.items || [],
                total: mesa.total || 0,
                horaApertura: mesa.horaApertura
            };
        });

        const mesasOrdenadas = ordenarMesasPorOrdenGuardado(data);
        mesasOrdenadas.forEach(mesa => {
            crearMesaElement(mesa.idCliente);
        });

        // Aplicar estados de mesas en uso
        Object.keys(mesasEnUso).forEach(idCliente => {
            actualizarEstadoMesaEnUso(idCliente);
        });
    } catch (error) {
        console.error('Error al cargar mesas:', error);
        alert('Error al cargar las mesas. Verifica la conexión con el servidor.');
    }
}

async function cargarProductos() {
    try {
        // Intentar cargar desde caché primero
        const cacheKey = 'productos_cache';
        const cacheTTL = 60 * 60 * 1000; // 1 hora
        const cached = localStorage.getItem(cacheKey);
        const cacheTime = localStorage.getItem(cacheKey + '_time');

        if (cached && cacheTime && (Date.now() - parseInt(cacheTime)) < cacheTTL) {
            console.log('✅ Usando productos desde caché');
            productos = JSON.parse(cached);
            return;
        }

        console.log('⬇️ Descargando productos desde servidor...');
        const response = await fetch(`${API_BASE}/articulos`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const data = await response.json();
        console.log('Productos cargados:', data.length);

        productos = data.map(item => ({
            id: item.iDaRTICULO,
            nombre: item.DESCRIP,
            precio: parseFloat(item.PRECIO) || 0,
            categoria: item.DESCRIPFAMILIA
        }));

        // Guardar en caché
        localStorage.setItem(cacheKey, JSON.stringify(productos));
        localStorage.setItem(cacheKey + '_time', Date.now().toString());
    } catch (error) {
        console.error('Error al cargar productos:', error);
    }
}

// =============================================
// REFRESCAR MESAS MANUALMENTE
// =============================================

async function refrescarMesas() {
    try {
        console.log('🔄 Refrescando mesas...');

        await cargarMesas();

        console.log('✅ Mesas actualizadas');

        // Feedback visual al usuario
        const btn = document.getElementById('refresh-mesas');
        if (btn) {
            const originalHTML = btn.innerHTML;
            btn.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M20 6L9 17l-5-5"/>
                </svg>
            `;
            btn.style.color = '#4CAF50';

            setTimeout(() => {
                btn.innerHTML = originalHTML;
                btn.style.color = '';
            }, 1500);
        }

    } catch (error) {
        console.error('Error al refrescar mesas:', error);
    }
}

// =============================================
// CONTROLES DE CANTIDAD
// =============================================

// Variable para almacenar la cantidad a insertar
let cantidadAInsertar = 1;

function configurarControlesCantidad() {
    const btnIncrease = document.getElementById('btn-increase-qty');
    const btnDecrease = document.getElementById('btn-decrease-qty');
    const quantityDisplay = document.getElementById('total-quantity');

    if (!btnIncrease || !btnDecrease || !quantityDisplay) return;

    // Actualizar display inicial
    quantityDisplay.textContent = cantidadAInsertar;

    // Aumentar cantidad a insertar
    btnIncrease.addEventListener('click', () => {
        cantidadAInsertar++;
        quantityDisplay.textContent = cantidadAInsertar;
    });

    // Disminuir cantidad a insertar
    btnDecrease.addEventListener('click', () => {
        if (cantidadAInsertar > 1) {
            cantidadAInsertar--;
            quantityDisplay.textContent = cantidadAInsertar;
        }
    });
}

// Función para resetear la cantidad después de insertar
function resetearCantidad() {
    cantidadAInsertar = 1;
    const quantityDisplay = document.getElementById('total-quantity');
    if (quantityDisplay) {
        quantityDisplay.textContent = cantidadAInsertar;
    }
}

// =============================================
// CERRAR SESIÓN Y LIMPIAR CACHÉ 
// =============================================

async function cerrarSesionYLimpiarCache() {
    try {
        console.log('🚪 Cerrando sesión...');

        // NO cerrar la mesa - solo cerrar el modal visual si está abierto
        if (modalMesa && modalMesa.style.display === 'block') {
            modalMesa.style.display = 'none';
        }

        // Limpiar caché de localStorage
        localStorage.removeItem('productos_cache');
        localStorage.removeItem('productos_cache_time');
        localStorage.removeItem('empleados_cache');
        localStorage.removeItem('empleados_cache_time');

        // Cerrar sesión del empleado
        sessionStorage.removeItem('empleado');
        empleadoActual = null;

        // Desconectar WebSocket
        if (ws) {
            ws.close();
        }

        // Resetear estado local (las mesas en la BD quedan intactas)
        mesaActual = null;
        productos = [];
        mesas = {};

        // Mostrar pantalla de login
        mostrarLogin();

        console.log('✅ Sesión cerrada - mesas intactas en BD');

    } catch (error) {
        console.error('Error al cerrar sesión:', error);
        alert('Error al cerrar sesión');
    }
}

// =============================================
// INICIALIZACIÓN
// =============================================

async function init() {
    configurarLoginEventos();

    const tieneSesion = await verificarSesion();

    if (tieneSesion) {
        actualizarEmpleadoActual();
        await cargarProductos();

        try {
            console.log('🔄 Iniciando carga de favoritos...');
            await cargarProductosFavoritos();
            console.log('✅ Carga de favoritos completada');
        } catch (error) {
            console.error('❌ Error en carga de favoritos (no crítico):', error);
        }

        await cargarMesas();
        await cargarMesasEnUso();

        conectarWebSocket();
    }

    if (closeBtn) closeBtn.addEventListener('click', cerrarModal);
    if (toggleEditBtn) toggleEditBtn.addEventListener('click', toggleModoEdicion);

    const toggleFullscreenBtn = document.getElementById('toggle-fullscreen');
    if (toggleFullscreenBtn) toggleFullscreenBtn.addEventListener('click', toggleFullScreen);

    const refreshCacheBtn = document.getElementById('refresh-cache');
    if (refreshCacheBtn) refreshCacheBtn.addEventListener('click', cerrarSesionYLimpiarCache);

    window.addEventListener('click', (e) => {
        if (e.target === modalMesa) {
            cerrarModal();
        }
    });

    configurarVistas();
    configurarTogglePedido();
    configurarBusquedaProductos();
    configurarBotonFavoritos();
    configurarControlesCantidad();

    // Botón de refresh manual de mesas
    const refreshMesasBtn = document.getElementById('refresh-mesas');
    if (refreshMesasBtn) refreshMesasBtn.addEventListener('click', refrescarMesas);

    // Polling automático cada 10 segundos para detectar cambios externos
    if (tieneSesion) {
        setInterval(async () => {
            // Solo recargar si no hay una mesa abierta (para no interrumpir al usuario)
            if (!mesaActual && modalMesa.style.display !== 'block') {
                await cargarMesas();
                console.log('🔄 Mesas actualizadas automáticamente');
            }
        }, 10000); // 10 segundos
    }
}

// =============================================
// CREAR ELEMENTO MESA
// =============================================

function crearMesaElement(idCliente) {
    const mesa = mesas[idCliente];
    const mesaElement = document.createElement('div');
    mesaElement.className = 'mesa';
    mesaElement.dataset.idCliente = idCliente;

    const ocupada = mesa.ocupada;
    const total = mesa.total || 0;

    mesaElement.innerHTML = `
        <span class="mesa-icon">${ocupada ? '☕' : '🪑'}</span>
        <div class="mesa-info">
            <div class="mesa-numero">${mesa.nombre}</div>
            <div class="mesa-estado">${ocupada ? `${total.toFixed(2)}€` : 'Libre'}</div>
        </div>
        ${ocupada && total > 0 ? `<div class="mesa-total">${total.toFixed(2)}€</div>` : ''}
    `;

    if (ocupada) {
        mesaElement.classList.add('ocupada');
    }

    mesaElement.setAttribute('draggable', 'true');
    configurarDragDrop(mesaElement);

    mesaElement.addEventListener('click', (e) => {
        if (e.target.closest('.mesa').classList.contains('dragging')) return;
        if (!modoEdicion) {
            abrirMesa(idCliente);
        }
    });

    mesasContainer.appendChild(mesaElement);
    return mesaElement;
}

// =============================================
// DRAG & DROP
// =============================================

let draggedMesa = null;

function configurarDragDrop(mesaElement) {
    mesaElement.addEventListener('dragstart', handleDragStart);
    mesaElement.addEventListener('dragend', handleDragEnd);
    mesaElement.addEventListener('dragover', handleDragOver);
    mesaElement.addEventListener('dragenter', handleDragEnter);
    mesaElement.addEventListener('dragleave', handleDragLeave);
    mesaElement.addEventListener('drop', handleDrop);
}

function handleDragStart(e) {
    if (!modoEdicion) {
        e.preventDefault();
        return;
    }
    draggedMesa = this;
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.dataset.idCliente);
}

function handleDragEnd(e) {
    this.classList.remove('dragging');
    document.querySelectorAll('.mesa').forEach(m => m.classList.remove('drag-over'));
    draggedMesa = null;
}

function handleDragOver(e) {
    if (!modoEdicion) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
}

function handleDragEnter(e) {
    if (!modoEdicion) return;
    e.preventDefault();
    if (this !== draggedMesa) {
        this.classList.add('drag-over');
    }
}

function handleDragLeave(e) {
    this.classList.remove('drag-over');
}

function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();

    if (!modoEdicion || !draggedMesa || this === draggedMesa) return;

    this.classList.remove('drag-over');

    const allMesas = Array.from(mesasContainer.querySelectorAll('.mesa'));
    const draggedIndex = allMesas.indexOf(draggedMesa);
    const targetIndex = allMesas.indexOf(this);

    if (draggedIndex < targetIndex) {
        this.parentNode.insertBefore(draggedMesa, this.nextSibling);
    } else {
        this.parentNode.insertBefore(draggedMesa, this);
    }

    guardarOrdenMesas();
    console.log('Mesas reordenadas');
}

function actualizarMesaElement(idCliente) {
    const mesa = mesas[idCliente];
    const mesaElement = document.querySelector(`.mesa[data-id-cliente="${idCliente}"]`);

    if (mesaElement && mesa) {
        const nombreEl = mesaElement.querySelector('.mesa-numero');
        if (nombreEl) nombreEl.textContent = mesa.nombre;

        mesaElement.classList.toggle('ocupada', mesa.ocupada);
        mesaElement.querySelector('.mesa-icon').textContent = mesa.ocupada ? '☕' : '🪑';
        mesaElement.querySelector('.mesa-estado').textContent = mesa.ocupada ? `${mesa.total.toFixed(2)}€` : 'Libre';

        let totalEl = mesaElement.querySelector('.mesa-total');
        if (mesa.ocupada && mesa.total > 0) {
            if (!totalEl) {
                totalEl = document.createElement('div');
                totalEl.className = 'mesa-total';
                mesaElement.appendChild(totalEl);
            }
            totalEl.textContent = mesa.total.toFixed(2) + '€';
        } else if (totalEl) {
            totalEl.remove();
        }
    }
}

// =============================================
// MODO EDICIÓN
// =============================================

function toggleModoEdicion() {
    modoEdicion = !modoEdicion;
    toggleEditBtn.classList.toggle('active');
    mesasContainer.classList.toggle('edit-mode');
    if (addMesaBtn) addMesaBtn.classList.toggle('hidden');

    const editText = toggleEditBtn.querySelector('.edit-text');
    if (editText) {
        editText.textContent = modoEdicion ? 'Salir' : 'Editar';
    }

    if (modoEdicion) {
        console.log('Modo edición activado: arrastra las mesas para reordenarlas');
    }
}

// =============================================
// FULLSCREEN
// =============================================

function toggleFullScreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
            console.log(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
        });
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        }
    }
}

// =============================================
// ABRIR MESA
// =============================================

async function abrirMesa(idCliente) {
    try {
        // Verificar si está en uso por otro
        const enUso = mesasEnUso[idCliente];
        if (enUso && enUso.idEmpleado !== empleadoActual?.id) {
            alert(`⚠️ Esta mesa está siendo usada por ${enUso.nombre}`);
            return;
        }

        // Ocupar la mesa
        const ocuparResponse = await fetch(`${API_BASE}/mesas/${idCliente}/ocupar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                idEmpleado: empleadoActual?.id,
                nombreEmpleado: empleadoActual?.nombre
            })
        });

        const ocuparData = await ocuparResponse.json();
        if (!ocuparData.success) {
            alert(`⚠️ Esta mesa está siendo usada por ${ocuparData.empleado}`);
            return;
        }

        console.log('Abriendo mesa cliente:', idCliente);
        mesaActual = idCliente;

        const mesa = mesas[idCliente];
        numeroMesaSpan.textContent = mesa.nombre;

        // Resetear estado del botón de favoritos
        mostrandoFavoritos = false;
        const btnFavoritos = document.getElementById('btn-favoritos');
        if (btnFavoritos) {
            btnFavoritos.classList.remove('active');
        }

        // Abrir mesa en el servidor
        await fetch(`${API_BASE}/mesas/${idCliente}/abrir`, {
            method: 'POST'
        });

        // Cargar items desde la BD
        const itemsResponse = await fetch(`${API_BASE}/mesas/${idCliente}/items`);
        const items = await itemsResponse.json();

        // Guardar items en el estado local de la mesa
        mesas[idCliente].items = items;
        mesas[idCliente].ocupada = items.length > 0;
        mesas[idCliente].total = items.reduce((sum, item) => sum + (item.precio * item.cantidad), 0);

        actualizarMesaElement(idCliente);

        mostrarProductos();
        actualizarItemsPedido();

        // CRÍTICO: Bloquear scroll del body para prevenir que el grid se redimensione
        document.body.classList.add('modal-open');
        modalMesa.style.display = 'block';
    } catch (error) {
        console.error('Error al abrir mesa:', error);
        alert('Error al abrir la mesa.');
        mesaActual = null;
    }
}

// =============================================
// PRODUCTOS
// =============================================

function mostrarProductos(terminoBusqueda = '') {
    productosDisponibles.innerHTML = '';

    // Filtrar productos si hay un término de búsqueda
    let productosFiltrados = productos;
    if (terminoBusqueda.trim()) {
        const termino = terminoBusqueda.toLowerCase();
        productosFiltrados = productos.filter(p =>
            p.nombre.toLowerCase().includes(termino)
        );
    }

    // Si hay búsqueda activa, mostrar todos los productos sin agrupar por categoría
    if (terminoBusqueda.trim()) {
        if (productosFiltrados.length === 0) {
            productosDisponibles.innerHTML = `
                <div style="padding: 2rem; text-align: center; color: #999;">
                    No se encontraron productos
                </div>
            `;
            return;
        }

        productosFiltrados.forEach(producto => {
            const productoElement = document.createElement('div');
            productoElement.className = 'producto';
            productoElement.innerHTML = `
                <div class="producto-nombre">${producto.nombre}</div>
                <div class="producto-precio">${producto.precio.toFixed(2)}€</div>
            `;
            productoElement.addEventListener('click', () => agregarProducto(producto));
            productosDisponibles.appendChild(productoElement);
        });
        return;
    }

    // Vista normal por categorías
    const categorias = [...new Set(productosFiltrados.map(p => p.categoria))].filter(c => c);

    categorias.forEach(categoria => {
        const categoriaElement = document.createElement('div');
        categoriaElement.className = 'categoria-productos';

        const categoriaHeader = document.createElement('div');
        categoriaHeader.className = 'categoria-header';
        categoriaHeader.innerHTML = `
            <h4>${categoria}</h4>
            <span class="toggle-icon">▶</span>
        `;

        const productosContainer = document.createElement('div');
        productosContainer.className = 'productos-categoria-container collapsed';

        const productosCategoria = productosFiltrados.filter(p => p.categoria === categoria);
        productosCategoria.forEach(producto => {
            const productoElement = document.createElement('div');
            productoElement.className = 'producto';
            productoElement.innerHTML = `
                <div class="producto-nombre">${producto.nombre}</div>
                <div class="producto-precio">${producto.precio.toFixed(2)}€</div>
            `;
            productoElement.addEventListener('click', () => agregarProducto(producto));
            productosContainer.appendChild(productoElement);
        });

        categoriaHeader.addEventListener('click', () => {
            productosContainer.classList.toggle('collapsed');
            const toggleIcon = categoriaHeader.querySelector('.toggle-icon');
            toggleIcon.textContent = productosContainer.classList.contains('collapsed') ? '▶' : '▼';
        });

        categoriaElement.appendChild(categoriaHeader);
        categoriaElement.appendChild(productosContainer);
        productosDisponibles.appendChild(categoriaElement);
    });
}

// =============================================
// GESTIÓN DE PEDIDO
// =============================================

async function agregarProducto(producto) {
    try {
        if (!mesaActual) return;

        console.log('Agregando producto:', producto, 'Cantidad:', cantidadAInsertar);

        const response = await fetch(`${API_BASE}/mesas/${mesaActual}/items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productoId: producto.id,
                nombre: producto.nombre,
                cantidad: cantidadAInsertar,
                precio: producto.precio,
                idEmpleado: empleadoActual?.id
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('Error del servidor al agregar producto:', errorData);
            alert('Error al agregar producto al servidor');
            return;
        }

        const data = await response.json();
        console.log('Producto agregado en servidor. Total:', data.total);

        // Resetear la cantidad a 1 después de agregar
        resetearCantidad();

        // Recargar items desde la BD para mantener sincronía
        const itemsResponse = await fetch(`${API_BASE}/mesas/${mesaActual}/items`);
        const items = await itemsResponse.json();

        const mesa = mesas[mesaActual];
        mesa.items = items;
        mesa.ocupada = items.length > 0;
        mesa.total = items.reduce((sum, item) => sum + (item.precio * item.cantidad), 0);

        actualizarItemsPedido();
        actualizarMesaElement(mesaActual);

    } catch (error) {
        console.error('Error al agregar producto:', error);
    }
}

function actualizarItemsPedido() {
    if (!mesaActual) return;

    const mesa = mesas[mesaActual];
    const itemsPedidoContainer = document.getElementById('items-pedido');
    const ultimoItemContainer = document.getElementById('ultimo-item-container');
    const badgeItems = document.getElementById('badge-items');

    itemsPedidoContainer.innerHTML = '';
    ultimoItemContainer.innerHTML = '';

    let total = 0;
    const numItems = mesa.items.length;

    // Actualizar badge contador
    badgeItems.textContent = numItems;

    if (numItems === 0) {
        // No hay items
        ultimoItemContainer.classList.add('empty');
        ultimoItemContainer.innerHTML = '<div class="ultimo-item-empty">Agrega artículos al pedido</div>';
    } else {
        ultimoItemContainer.classList.remove('empty');

        // Mostrar último item agregado
        const ultimoItem = mesa.items[mesa.items.length - 1];
        const subtotalUltimo = ultimoItem.precio * ultimoItem.cantidad;

        ultimoItemContainer.innerHTML = `
            <div class="ultimo-item">
                <div class="ultimo-item-info">
                    <span class="ultimo-item-nombre">${ultimoItem.nombre}</span>
                    <span class="ultimo-item-cantidad">x${ultimoItem.cantidad}</span>
                </div>
                <div class="ultimo-item-precio">${subtotalUltimo.toFixed(2)}€</div>
            </div>
        `;
    }

    // Renderizar todos los items en la lista expandible
    mesa.items.forEach((item, index) => {
        const subtotal = item.precio * item.cantidad;
        total += subtotal;

        const itemElement = document.createElement('div');
        itemElement.className = 'item-pedido';
        itemElement.innerHTML = `
            <div class="item-info">
                <span class="item-nombre">${item.nombre}</span>
                <span class="item-cantidad">x${item.cantidad}</span>
            </div>
            <div class="item-precios">
                <span class="item-subtotal">${subtotal.toFixed(2)}€</span>
                <button class="btn btn-eliminar" data-id="${item.id}">Eliminar</button>
            </div>
        `;

        itemElement.querySelector('.btn-eliminar').addEventListener('click', () => eliminarItem(item.id));
        itemsPedidoContainer.appendChild(itemElement);
    });

    totalPedido.textContent = total.toFixed(2);
    mesa.total = total;

    // Botones de acción
    let accionesDiv = document.getElementById('acciones-pedido');
    if (!accionesDiv) {
        accionesDiv = document.createElement('div');
        accionesDiv.id = 'acciones-pedido';

        const btnLimpiar = document.createElement('button');
        btnLimpiar.className = 'btn btn-eliminar';
        btnLimpiar.textContent = '🗑️ Limpiar Mesa';
        btnLimpiar.onclick = limpiarMesa;

        const btnImprimir = document.createElement('button');
        btnImprimir.className = 'btn btn-imprimir';
        btnImprimir.textContent = '🖨️ Imprimir';
        btnImprimir.onclick = () => {
            // Funcionalidad pendiente
            console.log('Imprimir ticket');
        };

        const btnImprimirSeparado = document.createElement('button');
        btnImprimirSeparado.className = 'btn btn-imprimir-separado';
        btnImprimirSeparado.textContent = '🖨️ Imprimir Separado';
        btnImprimirSeparado.onclick = () => {
            // Funcionalidad pendiente
            console.log('Imprimir ticket separado');
        };

        accionesDiv.appendChild(btnLimpiar);
        accionesDiv.appendChild(btnImprimir);
        accionesDiv.appendChild(btnImprimirSeparado);

        const totalDiv = document.querySelector('.pedido-actual .total');
        if (totalDiv) {
            totalDiv.parentNode.insertBefore(accionesDiv, totalDiv.nextSibling);
        }
    }
}

async function eliminarItem(productoId) {
    try {
        if (!mesaActual) return;

        await fetch(`${API_BASE}/mesas/${mesaActual}/items/${productoId}`, {
            method: 'DELETE'
        });

        // Recargar items desde la BD
        const itemsResponse = await fetch(`${API_BASE}/mesas/${mesaActual}/items`);
        const items = await itemsResponse.json();

        const mesa = mesas[mesaActual];
        mesa.items = items;
        mesa.ocupada = items.length > 0;
        mesa.total = items.reduce((sum, item) => sum + (item.precio * item.cantidad), 0);

        actualizarItemsPedido();
        actualizarMesaElement(mesaActual);

    } catch (error) {
        console.error('Error al eliminar item:', error);
    }
}

// =============================================
// CREAR TICKET EN TPV
// =============================================

async function crearTicket() {
    try {
        if (!mesaActual) return;

        const mesa = mesas[mesaActual];
        if (mesa.items.length === 0) {
            alert('No hay productos en el pedido');
            return;
        }

        console.log('Creando ticket para cliente:', mesaActual);

        const response = await fetch(`${API_BASE}/tickets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                idCliente: mesaActual
            })
        });

        const data = await response.json();

        if (data.success) {
            alert(`✅ Ticket #${data.Numero} creado correctamente\nTotal: ${data.Total.toFixed(2)}€`);

            mesa.ocupada = false;
            mesa.items = [];
            mesa.total = 0;
            mesa.horaApertura = null;

            actualizarMesaElement(mesaActual);
            cerrarModal();
        } else {
            alert('❌ Error al crear el ticket: ' + (data.error || 'Error desconocido'));
        }
    } catch (error) {
        console.error('Error al crear ticket:', error);
        alert('❌ Error al crear el ticket');
    }
}

// =============================================
// LIMPIAR MESA
// =============================================

async function limpiarMesa() {
    try {
        if (!mesaActual) return;

        const confirmar = await mostrarModalConfirmar();
        if (!confirmar) {
            return;
        }

        await fetch(`${API_BASE}/mesas/${mesaActual}/cerrar`, {
            method: 'POST'
        });

        const mesa = mesas[mesaActual];
        mesa.ocupada = false;
        mesa.items = [];
        mesa.total = 0;
        mesa.horaApertura = null;

        actualizarMesaElement(mesaActual);
        cerrarModal();

    } catch (error) {
        console.error('Error al limpiar mesa:', error);
        alert('Error al limpiar la mesa');
    }
}

// =============================================
// MODAL CONFIRMACIÓN PERSONALIZADO
// =============================================

function mostrarModalConfirmar() {
    return new Promise((resolve) => {
        const modal = document.getElementById('modal-confirmar-limpiar');
        const btnConfirmar = document.getElementById('btn-confirmar-limpiar');
        const btnCancelar = document.getElementById('btn-cancelar-limpiar');

        modal.style.display = 'block';

        const confirmarHandler = () => {
            modal.style.display = 'none';
            btnConfirmar.removeEventListener('click', confirmarHandler);
            btnCancelar.removeEventListener('click', cancelarHandler);
            resolve(true);
        };

        const cancelarHandler = () => {
            modal.style.display = 'none';
            btnConfirmar.removeEventListener('click', confirmarHandler);
            btnCancelar.removeEventListener('click', cancelarHandler);
            resolve(false);
        };

        btnConfirmar.addEventListener('click', confirmarHandler);
        btnCancelar.addEventListener('click', cancelarHandler);

        // Cerrar al hacer click fuera del modal
        modal.addEventListener('click', function clickOutside(e) {
            if (e.target === modal) {
                modal.style.display = 'none';
                btnConfirmar.removeEventListener('click', confirmarHandler);
                btnCancelar.removeEventListener('click', cancelarHandler);
                modal.removeEventListener('click', clickOutside);
                resolve(false);
            }
        });
    });
}


// =============================================
// CERRAR MODAL
// =============================================

function cerrarModal() {
    // Liberar la mesa
    if (mesaActual && empleadoActual) {
        fetch(`${API_BASE}/mesas/${mesaActual}/liberar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                idEmpleado: empleadoActual.id
            })
        });
    }

    // CRÍTICO: Restaurar scroll del body
    document.body.classList.remove('modal-open');
    modalMesa.style.display = 'none';
    mesaActual = null;

    const accionesDiv = document.getElementById('acciones-pedido');
    if (accionesDiv) accionesDiv.remove();
}

// =============================================
// INICIAR APLICACIÓN
// =============================================

document.addEventListener('DOMContentLoaded', init);