// Configuración
const debug = false;
const API_BASE = '/api';

// Lista de precios actual según tipo de mesa (1=Comedor/defecto, 4=Terraza)
let idListaActual = 1;

// Silenciar logs si debug es false
if (!debug) {
    const originalLog = console.log;
    console.log = function () { };
    // También silenciamos debug si existe
    if (console.debug) console.debug = function () { };
}


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
let intervalPolling = null; // ID del intervalo de refresco automático de mesas

// En app.js, añade esto junto a las otras variables globales
let timerInactividad = null;
const SEGUNDOS_INACTIVIDAD = 90; // ⚠️ SOLO PARA PRUEBAS - volver a minutos después

// Timestamp de la última actividad (para móvil, donde setTimeout se congela)
let ultimaActividad = Date.now();

function resetearTimerInactividad() {
    ultimaActividad = Date.now();
    clearTimeout(timerInactividad);
    if (!empleadoActual) return;

    timerInactividad = setTimeout(() => {
        console.log('⏰ Sesión cerrada por inactividad (setTimeout)');
        cerrarSesionYLimpiarCache();
    }, SEGUNDOS_INACTIVIDAD * 1000);
}

// Móvil: cuando el usuario vuelve a la app tras tenerla en background,
// se comprueba si ya expiró el tiempo de inactividad
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && empleadoActual) {
        const msInactivo = Date.now() - ultimaActividad;
        if (msInactivo >= SEGUNDOS_INACTIVIDAD * 1000) {
            console.log('⏰ Sesión cerrada por inactividad (visibilitychange)');
            cerrarSesionYLimpiarCache();
        }
    }
});

// Reiniciar el timer con cualquier interacción del usuario
['touchstart', 'click', 'keydown'].forEach(evento => {
    document.addEventListener(evento, resetearTimerInactividad, { passive: true });
});

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
        } else if (datos.tipo === 'mesa_expulsado') {
            // Soy el usuario expulsado de esta mesa?
            if (datos.idEmpleadoExpulsado === empleadoActual?.id) {
                console.log('⚡ Fui expulsado de la mesa', datos.idCliente, 'por', datos.expulsadoPor);
                // Cerrar el modal de la mesa si está abierto y es la mesa de la que me expulsan
                if (mesaActual == datos.idCliente && modalMesa.style.display === 'block') {
                    cerrarModal();
                }
                // Mostrar toast de aviso
                const nombreMesa = mesas[datos.idCliente]?.nombre || `Mesa ${datos.idCliente}`;
                mostrarToastExpulsado(`⚡ ${datos.expulsadoPor} ha tomado el control de ${nombreMesa}`);
            }
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
    // Resetear siempre al paso 1 (selección de empleado)
    empleadoSeleccionado = null;
    pinIngresado = '';
    document.getElementById('login-step-1').classList.remove('hidden');
    document.getElementById('login-step-2').classList.add('hidden');
    document.getElementById('pin-error').classList.add('hidden');

    document.getElementById('login-screen').classList.remove('hidden');
    cargarEmpleados();
}

function ocultarLogin() {
    document.getElementById('login-screen').classList.add('hidden');
    resetearTimerInactividad();
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

            // Refresco automático de mesas cada 5 segundos
            if (intervalPolling) clearInterval(intervalPolling);
            intervalPolling = setInterval(() => {
                cargarMesas();
            }, 5000);
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
        // Ordenar items
        mesa.items = ordenarItems(items);
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
            itemElement.style.overflow = 'visible';
            itemElement.style.height = 'auto';
            itemElement.style.marginBottom = '1rem';
            itemElement.innerHTML = `
    <div class="item-info">
        <span class="item-nombre">${item.nombre}</span>
        <span class="item-cantidad">x${item.cantidad}</span>
    </div>
    <div class="item-precios" style="overflow: visible; height: auto; display: flex; flex-direction: column; gap: 0.5rem; width: 100%;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
            <span class="item-subtotal">${subtotal.toFixed(2)}€</span>
        </div>
        <div style="display: flex; justify-content: flex-end; align-items: center; gap: 1rem; width: 100%;">
            <div style="display: flex; gap: 0.5rem;">
                <button class="btn btn-menos-cantidad" data-idlinea="${item.IdLinea}" data-cantidad="${item.cantidad}" style="background: #c0392b; color: white; padding: 0.2rem 0.7rem; border: none; border-radius: 8px; cursor: pointer; font-size: 2.2rem; font-weight: bold; line-height: 1; min-width: 3rem; text-align: center;">−</button>
                <button class="btn btn-mas-cantidad" data-idlinea="${item.IdLinea}" data-cantidad="${item.cantidad}" style="background: #27ae60; color: white; padding: 0.2rem 0.7rem; border: none; border-radius: 8px; cursor: pointer; font-size: 2.2rem; font-weight: bold; line-height: 1; min-width: 3rem; text-align: center;">+</button>
            </div>
            <div style="display: flex; gap: 0.4rem;">
                <button class="btn btn-complementos" data-id="${item.id}" data-idlinea="${item.IdLinea}" style="background: #8B4513; color: white; padding: 0.1rem 0.3rem; border: none; border-radius: 4px; cursor: pointer; font-size: 1.7rem;">🍴</button>
                <button class="btn btn-eliminar" data-idlinea="${item.IdLinea}" style="padding: 0.1rem 0.3rem; font-size: 1.7rem;">🗑️</button>
            </div>
        </div>
    </div>
`;

            // Event listener para complementos
            itemElement.querySelector('.btn-complementos').addEventListener('click', () => {
                console.log('Abriendo complementos desde modal ticket para:', item.nombre);
                abrirModalComplementos(item.id, item.IdTicket, item);
            });

            itemElement.querySelector('.btn-eliminar').addEventListener('click', async () => {
                await eliminarItem(item.IdLinea);
                // Actualizar el modal después de eliminar
                abrirModalTicket();
            });

            itemElement.querySelector('.btn-menos-cantidad').addEventListener('click', async () => {
                const nuevaCantidad = item.cantidad - 1;
                await actualizarCantidadLinea(item.IdLinea, nuevaCantidad);
                abrirModalTicket();
            });

            itemElement.querySelector('.btn-mas-cantidad').addEventListener('click', async () => {
                const nuevaCantidad = item.cantidad + 1;
                await actualizarCantidadLinea(item.IdLinea, nuevaCantidad);
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
        const response = await fetch(`${API_BASE}/favoritos?idLista=${idListaActual}`);

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

function ordenarItems(items) {
    if (!items || !Array.isArray(items)) return [];
    // Ordenar por IdLinea ascendente para que el último insertado quede al final
    return items.sort((a, b) => (a.IdLinea || 0) - (b.IdLinea || 0));
}

async function cargarMesas() {
    try {
        console.log('Cargando mesas desde clientes...');
        const response = await fetch(`${API_BASE}/mesas`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const data = await response.json();
        console.log('Mesas cargadas:', data);

        cargarOrdenMesas();

        const mesasAnteriores = { ...mesas };
        mesas = {};
        mesasContainer.innerHTML = '';

        data.forEach(mesa => {
            // Si es la mesa actual, preservar items y idTicket local
            let items = mesa.items || [];
            let idTicket = mesa.idTicket;
            let total = mesa.total || 0;

            if (mesaActual === mesa.idCliente && mesasAnteriores[mesaActual]) {
                const mesaLocal = mesasAnteriores[mesaActual];
                if (mesaLocal.items && mesaLocal.items.length > 0) {
                    items = mesaLocal.items;
                    total = mesaLocal.total; // Preservar total calculado localmente
                }
                if (mesaLocal.idTicket) {
                    idTicket = mesaLocal.idTicket;
                }
            }

            mesas[mesa.idCliente] = {
                idCliente: mesa.idCliente,
                codigo: mesa.codigo,
                nombre: mesa.nombre,
                ocupada: mesa.ocupada,
                items: items,
                total: total,
                horaApertura: mesa.horaApertura,
                idTicket: idTicket
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

async function cargarProductos(idLista = 1) {
    try {
        // La clave de caché incluye la lista para que T y C tengan sus propios precios cacheados
        const cacheKey = `productos_cache_lista_${idLista}`;
        const cacheTTL = 60 * 60 * 1000; // 1 hora
        const cached = localStorage.getItem(cacheKey);
        const cacheTime = localStorage.getItem(cacheKey + '_time');

        if (cached && cacheTime && (Date.now() - parseInt(cacheTime)) < cacheTTL) {
            console.log(`✅ Usando productos desde caché (lista ${idLista})`);
            productos = JSON.parse(cached);
            return;
        }

        console.log(`⬇️ Descargando productos desde servidor (lista ${idLista})...`);
        const response = await fetch(`${API_BASE}/articulos?idLista=${idLista}`);
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

        // Detener polling automático
        if (intervalPolling) {
            clearInterval(intervalPolling);
            intervalPolling = null;
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

    // Polling automático cada 15 segundos para detectar cambios del TPV externo
    if (tieneSesion) {
        intervalPolling = setInterval(async () => {
            if (empleadoActual) {
                await cargarMesas();
                console.log('🔄 Mesas actualizadas automáticamente');
            }
        }, 15000); // 15 segundos
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

async function abrirMesa(idCliente, opciones = {}) {
    try {
        const forzar = opciones.forzar || false;

        // Verificar si está en uso por otro (solo si no forzamos)
        if (!forzar) {
            const enUso = mesasEnUso[idCliente];
            if (enUso && enUso.idEmpleado !== empleadoActual?.id) {
                mostrarDialogoMesaOcupada(idCliente, enUso.nombre);
                return;
            }
        }

        // Ocupar la mesa (con o sin forzar)
        const ocuparResponse = await fetch(`${API_BASE}/mesas/${idCliente}/ocupar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                idEmpleado: empleadoActual?.id,
                nombreEmpleado: empleadoActual?.nombre,
                forzar
            })
        });

        const ocuparData = await ocuparResponse.json();
        if (!ocuparData.success) {
            // Última verificación del servidor (raza de condición)
            mostrarDialogoMesaOcupada(idCliente, ocuparData.empleado);
            return;
        }

        console.log('Abriendo mesa cliente:', idCliente);
        mesaActual = idCliente;

        const mesa = mesas[idCliente];
        numeroMesaSpan.textContent = mesa.nombre;

        // Determinar la lista de precios según el tipo de mesa (T=Terraza lista 4, resto lista 1)
        const nombreMesa = mesa.nombre || '';
        idListaActual = nombreMesa.toUpperCase().startsWith('T') ? 4 : 1;
        console.log(`💰 Mesa "${nombreMesa}" → Lista de precios: ${idListaActual}`);

        // Cargar productos con la lista correcta
        await cargarProductos(idListaActual);

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
        // Ordenar items
        mesas[idCliente].items = ordenarItems(items);
        mesas[idCliente].ocupada = items.length > 0;
        mesas[idCliente].total = items.reduce((sum, item) => sum + (item.precio * item.cantidad), 0);
        // Guardar el IdTicket si hay items
        if (items.length > 0 && items[0].IdTicket) {
            mesas[idCliente].idTicket = items[0].IdTicket;
        }

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

        // DESPUÉS (corregido):
        const data = await response.json();
        console.log('Producto agregado en servidor. Total:', data.total, 'IdTicket:', data.idTicket);
        resetearCantidad();

        // Asignar idTicket INMEDIATAMENTE desde la respuesta del POST
        const mesa = mesas[mesaActual];
        if (data.idTicket) {
            mesa.idTicket = data.idTicket;
            console.log('✅ IdTicket asignado:', mesa.idTicket);
        }

        const itemsResponse = await fetch(`${API_BASE}/mesas/${mesaActual}/items`);
        const items = await itemsResponse.json();

        // CRÍTICO: Re-obtener la referencia a la mesa porque cargarMesas() puede haber
        // recreado el objeto mesas mientras esperábamos el fetch
        if (mesas[mesaActual]) {
            const mesaActualizada = mesas[mesaActual];

            // Ordenar items por IdLinea para asegurar consistencia
            mesaActualizada.items = ordenarItems(items);
            mesaActualizada.ocupada = items.length > 0;
            mesaActualizada.total = items.reduce((sum, item) => sum + (item.precio * item.cantidad), 0);

            // Fallback por si no vino en la respuesta POST
            if (!mesaActualizada.idTicket && items.length > 0 && items[0].IdTicket) {
                mesaActualizada.idTicket = items[0].IdTicket;
                console.log('✅ IdTicket asignado desde items:', mesaActualizada.idTicket);
            }

            actualizarItemsPedido();
            actualizarMesaElement(mesaActual);
        }

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
        ultimoItemContainer.innerHTML = '';
        ultimoItemContainer.classList.remove('empty');

        // Mostrar último item agregado
        const ultimoItem = mesa.items[mesa.items.length - 1];
        const subtotalUltimo = ultimoItem.precio * ultimoItem.cantidad;

        const ultimoItemDiv = document.createElement('div');
        ultimoItemDiv.className = 'ultimo-item';
        ultimoItemDiv.innerHTML = `
            <div class="ultimo-item-info">
                <span class="ultimo-item-nombre">${ultimoItem.nombre}</span>
                <span class="ultimo-item-cantidad">x${ultimoItem.cantidad}</span>
            </div>
            <div class="ultimo-item-precio">${subtotalUltimo.toFixed(2)}€</div>
        `;

        // Agregar evento de click para abrir modal de complementos
        ultimoItemDiv.addEventListener('click', () => {
            abrirModalComplementos(ultimoItem.id, ultimoItem.IdTicket, ultimoItem);
        });

        ultimoItemContainer.appendChild(ultimoItemDiv);
    }

    // Renderizar todos los items en la lista expandible
    mesa.items.forEach((item, index) => {
        const subtotal = item.precio * item.cantidad;
        total += subtotal;

        const itemElement = document.createElement('div');
        itemElement.className = 'item-pedido';
        itemElement.style.overflow = 'visible';
        itemElement.style.height = 'auto';
        itemElement.style.marginBottom = '1rem';
        itemElement.innerHTML = `
            <div class="item-info">
                <span class="item-nombre">${item.nombre}</span>
                <span class="item-cantidad">x${item.cantidad}</span>
            </div>
            <div class="item-precios" style="overflow: visible; height: auto; display: flex; flex-direction: column; gap: 0.5rem; width: 100%;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span class="item-subtotal">${subtotal.toFixed(2)}€</span>
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 0.5rem; width: 100%;">
                    <button class="btn btn-complementos" data-id="${item.id}" data-idlinea="${item.IdLinea}" style="background: #8B4513; color: white; padding: 0.1rem 0.3rem; border: none; border-radius: 4px; cursor: pointer; font-size: 1.7rem;">🍴</button>
                    <button class="btn btn-eliminar" data-idlinea="${item.IdLinea}" style="padding: 0.1rem 0.3rem; font-size: 1.7rem;">🗑️</button>
                </div>
            </div>
        `;

        // Botón de complementos
        const btnComplementos = itemElement.querySelector('.btn-complementos');
        btnComplementos.addEventListener('click', (e) => {
            e.stopPropagation();
            console.log('Abriendo complementos para:', item.nombre, item);
            abrirModalComplementos(item.id, item.IdTicket, item);
        });

        // Botón eliminar
        const btnEliminar = itemElement.querySelector('.btn-eliminar');
        btnEliminar.addEventListener('click', (e) => {
            e.stopPropagation();
            eliminarItem(item.IdLinea);
        });

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
        btnImprimir.onclick = abrirModalImpresoras;

        accionesDiv.appendChild(btnLimpiar);
        accionesDiv.appendChild(btnImprimir);

        const totalDiv = document.querySelector('.pedido-actual .total');
        if (totalDiv) {
            totalDiv.parentNode.insertBefore(accionesDiv, totalDiv.nextSibling);
        }
    }
}

async function eliminarItem(idLinea) {
    try {
        if (!mesaActual) return;

        await fetch(`${API_BASE}/mesas/${mesaActual}/items/${idLinea}`, {
            method: 'DELETE'
        });

        // Recargar items desde la BD
        const itemsResponse = await fetch(`${API_BASE}/mesas/${mesaActual}/items`);
        const items = await itemsResponse.json();

        const mesa = mesas[mesaActual];
        // Ordenar items
        mesa.items = ordenarItems(items);
        mesa.ocupada = items.length > 0;
        mesa.total = items.reduce((sum, item) => sum + (item.precio * item.cantidad), 0);
        // Guardar el IdTicket si hay items
        if (items.length > 0 && items[0].IdTicket) {
            mesa.idTicket = items[0].IdTicket;
        }

        actualizarItemsPedido();
        actualizarMesaElement(mesaActual);

    } catch (error) {
        console.error('Error al eliminar item:', error);
    }
}

async function actualizarCantidadLinea(idLinea, nuevaCantidad) {
    try {
        if (!mesaActual) return;

        if (nuevaCantidad <= 0) {
            // Si la cantidad llega a 0, eliminar la línea
            await eliminarItem(idLinea);
            return;
        }

        await fetch(`${API_BASE}/mesas/${mesaActual}/items/${idLinea}/cantidad-linea`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cantidad: nuevaCantidad })
        });

        // Recargar items desde la BD
        const itemsResponse = await fetch(`${API_BASE}/mesas/${mesaActual}/items`);
        const items = await itemsResponse.json();

        const mesa = mesas[mesaActual];
        mesa.items = ordenarItems(items);
        mesa.ocupada = items.length > 0;
        mesa.total = items.reduce((sum, item) => sum + (item.precio * item.cantidad), 0);
        if (items.length > 0 && items[0].IdTicket) {
            mesa.idTicket = items[0].IdTicket;
        }

        actualizarItemsPedido();
        actualizarMesaElement(mesaActual);

    } catch (error) {
        console.error('Error al actualizar cantidad de línea:', error);
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

// =============================================
// MODAL COMPLEMENTOS
// =============================================

let idArticuloActual = null;
let idTicketActual = null;
let itemActual = null;

// Abrir modal de complementos
// Abrir modal de complementos
async function abrirModalComplementos(idArticulo, idTicket, item) {
    try {
        console.log('--- ABRIR MODAL COMPLEMENTOS ---');
        console.log('ID Articulo:', idArticulo);
        console.log('ID Ticket:', idTicket);
        console.log('Item:', item);

        idArticuloActual = idArticulo;
        idTicketActual = idTicket;
        itemActual = item;

        // Validaciones básicas
        if (!item) {
            console.error('❌ Error: El item es nulo o indefinido');
            return;
        }

        if (!mesaActual) {
            console.error('❌ Error: No hay mesa actual');
            return;
        }

        // Usar las observaciones del item pasado directamente
        const observacionesActuales = item.observaciones || '';
        console.log('Observaciones actuales:', observacionesActuales);

        // Parsear observaciones existentes (separadas por comas)
        const complementosExistentes = observacionesActuales
            .split(',')
            .map(c => c.trim())
            .filter(c => c.length > 0);

        console.log('Solicitando complementos al servidor...');

        // Obtener complementos del artículo
        const response = await fetch(`${API_BASE}/articulos/${idArticulo}/complementos`);

        if (!response.ok) {
            console.error(`❌ Error HTTP: ${response.status} al obtener complementos`);
            return;
        }

        const complementos = await response.json();
        console.log('✅ Complementos obtenidos:', complementos.length);

        const modalComplementos = document.getElementById('modal-complementos');
        const complementosLista = document.getElementById('complementos-lista');
        const complementoTexto = document.getElementById('complemento-texto');

        if (!modalComplementos || !complementosLista) {
            console.error('❌ Error: No se encontraron elementos del DOM para el modal');
            return;
        }

        complementosLista.innerHTML = '';

        // Separar complementos existentes en predefinidos y personalizados
        const complementosPredefinidos = complementos.map(c => c.nombre);
        const complementosPersonalizados = complementosExistentes.filter(
            c => !complementosPredefinidos.includes(c)
        );

        if (complementos.length === 0) {
            complementosLista.innerHTML = '<div class="complementos-empty">No hay complementos predefinidos para este artículo</div>';
        } else {
            complementos.forEach((complemento, index) => {
                const complementoItem = document.createElement('div');
                complementoItem.className = 'complemento-item';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = `complemento-${index}`;
                checkbox.value = complemento.nombre;

                // Marcar checkbox si estaba previamente seleccionado
                if (complementosExistentes.includes(complemento.nombre)) {
                    checkbox.checked = true;
                }

                const label = document.createElement('label');
                label.htmlFor = `complemento-${index}`;
                label.textContent = complemento.nombre;

                complementoItem.appendChild(checkbox);
                complementoItem.appendChild(label);

                // Hacer que todo el item sea clickable
                complementoItem.addEventListener('click', (e) => {
                    if (e.target !== checkbox) {
                        checkbox.checked = !checkbox.checked;
                    }
                });

                complementosLista.appendChild(complementoItem);
            });
        }

        // Poner complementos personalizados en el campo de texto
        if (complementoTexto) {
            complementoTexto.value = complementosPersonalizados.join(', ');
        }

        console.log('Mostrando modal...');
        modalComplementos.style.display = 'block';
    } catch (error) {
        console.error('❌ Error fatal al abrir modal de complementos:', error);
    }
}

// Aplicar complementos seleccionados (guardar en observaciones)
async function aplicarComplementos() {
    try {
        const complementosSeleccionados = [];

        // Obtener todos los checkboxes marcados
        const checkboxes = document.querySelectorAll('.complemento-item input[type="checkbox"]:checked');
        checkboxes.forEach(checkbox => {
            complementosSeleccionados.push(checkbox.value);
        });

        // Obtener texto libre si existe
        const complementoTexto = document.getElementById('complemento-texto');
        if (complementoTexto && complementoTexto.value.trim()) {
            complementosSeleccionados.push(complementoTexto.value.trim());
        }

        if (complementosSeleccionados.length === 0) {
            cerrarModalComplementos();
            return;
        }

        // Concatenar con comas
        const observaciones = complementosSeleccionados.join(', ');
        console.log('Guardando observaciones:', observaciones);

        // GUARDAR EN LA BASE DE DATOS
        if (!itemActual || !itemActual.IdTicket || !itemActual.IdLinea) {
            console.error('Falta información del item para guardar observaciones', itemActual);
            cerrarModalComplementos();
            return;
        }

        console.log(`Llamando PUT /api/tickets/${itemActual.IdTicket}/lineas/${itemActual.IdLinea}/observaciones`);

        // Llamar al endpoint PUT para actualizar las observaciones
        const updateResponse = await fetch(`${API_BASE}/tickets/${itemActual.IdTicket}/lineas/${itemActual.IdLinea}/observaciones`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ observaciones })
        });

        if (!updateResponse.ok) {
            const errorData = await updateResponse.text();
            console.error('Error al guardar observaciones:', errorData);
            alert('Error al guardar complementos');
            cerrarModalComplementos();
            return;
        }

        console.log(`✅ Observaciones guardadas exitosamente: "${observaciones}"`);

        // Actualizar el item local
        itemActual.observaciones = observaciones;

        // Cerrar modal
        cerrarModalComplementos();

    } catch (error) {
        console.error('Error al aplicar complementos:', error);
        alert('Error al guardar complementos');
        cerrarModalComplementos();
    }
}

// Cerrar modal de complementos
function cerrarModalComplementos() {
    const modalComplementos = document.getElementById('modal-complementos');
    if (modalComplementos) {
        modalComplementos.style.display = 'none';
    }
    idArticuloActual = null;
}

// Event listeners para cerrar el modal
document.addEventListener('DOMContentLoaded', () => {
    const closeComplementosBtn = document.querySelector('.close-complementos');
    if (closeComplementosBtn) {
        closeComplementosBtn.addEventListener('click', cerrarModalComplementos);
    }

    const modalComplementos = document.getElementById('modal-complementos');
    if (modalComplementos) {
        modalComplementos.addEventListener('click', (e) => {
            if (e.target === modalComplementos) {
                cerrarModalComplementos();
            }
        });
    }

    // Botón aplicar complementos
    const btnAplicar = document.getElementById('btn-aplicar-complementos');
    if (btnAplicar) {
        btnAplicar.addEventListener('click', aplicarComplementos);
    }

    // Botón cancelar complementos
    const btnCancelar = document.getElementById('btn-cancelar-complementos');
    if (btnCancelar) {
        btnCancelar.addEventListener('click', cerrarModalComplementos);
    }

    // ===== MODAL IMPRESORAS EVENT LISTENERS =====
    const closeImpresorasBtn = document.querySelector('.close-impresoras');
    if (closeImpresorasBtn) {
        closeImpresorasBtn.addEventListener('click', cerrarModalImpresoras);
    }

    const modalImpresoras = document.getElementById('modal-impresoras');
    if (modalImpresoras) {
        modalImpresoras.addEventListener('click', (e) => {
            if (e.target === modalImpresoras) {
                cerrarModalImpresoras();
            }
        });
    }

    const btnCancelarImpresoras = document.getElementById('btn-cancelar-impresoras');
    if (btnCancelarImpresoras) {
        btnCancelarImpresoras.addEventListener('click', cerrarModalImpresoras);
    }

    const btnImprimirSeleccionadas = document.getElementById('btn-imprimir-seleccionadas');
    if (btnImprimirSeleccionadas) {
        btnImprimirSeleccionadas.addEventListener('click', imprimirSeleccionadas);
    }
});

// =============================================
// MODAL IMPRESORAS - Funciones
// =============================================

// Abrir modal de impresoras
async function abrirModalImpresoras() {
    try {
        console.log('Abriendo modal de impresoras...');

        // Obtener impresoras del servidor
        const response = await fetch(`${API_BASE}/impresoras`);

        if (!response.ok) {
            console.error('Error al obtener impresoras:', response.status);
            alert('Error al obtener la lista de impresoras');
            return;
        }

        const impresoras = await response.json();
        console.log('Impresoras obtenidas:', impresoras);

        const modalImpresoras = document.getElementById('modal-impresoras');
        const impresorasLista = document.getElementById('impresoras-lista');

        if (!modalImpresoras || !impresorasLista) {
            console.error('No se encontraron elementos del DOM para el modal de impresoras');
            return;
        }

        impresorasLista.innerHTML = '';

        if (impresoras.length === 0) {
            impresorasLista.innerHTML = '<div class="impresoras-empty">No hay impresoras configuradas</div>';
        } else {
            impresoras.forEach((impresora, index) => {
                const impresoraItem = document.createElement('div');
                impresoraItem.className = 'impresora-item';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = `impresora-${index}`;
                checkbox.value = impresora.Id;
                checkbox.dataset.nombre = impresora.Nombre;
                checkbox.dataset.ip = impresora.IP;
                checkbox.dataset.puerto = impresora.Puerto || '9100';

                const label = document.createElement('label');
                label.htmlFor = `impresora-${index}`;
                label.textContent = impresora.Nombre;

                impresoraItem.appendChild(checkbox);
                impresoraItem.appendChild(label);

                // Hacer que todo el item sea clickable
                impresoraItem.addEventListener('click', (e) => {
                    if (e.target !== checkbox && e.target.tagName !== 'LABEL') {
                        checkbox.checked = !checkbox.checked;
                    }
                });

                impresorasLista.appendChild(impresoraItem);
            });
        }

        modalImpresoras.style.display = 'block';
    } catch (error) {
        console.error('Error al abrir modal de impresoras:', error);
        alert('Error al cargar las impresoras');
    }
}

// Cerrar modal de impresoras
function cerrarModalImpresoras() {
    const modalImpresoras = document.getElementById('modal-impresoras');
    if (modalImpresoras) {
        modalImpresoras.style.display = 'none';
    }
}

// Imprimir en las impresoras seleccionadas
async function imprimirSeleccionadas() {
    try {
        // Obtener checkboxes seleccionados
        const checkboxes = document.querySelectorAll('.impresora-item input[type="checkbox"]:checked');

        if (checkboxes.length === 0) {
            alert('Por favor selecciona al menos una impresora');
            return;
        }

        if (!mesaActual) {
            alert('No hay una mesa activa');
            return;
        }

        const mesa = mesas[mesaActual];
        if (!mesa || !mesa.idTicket) {
            alert('No hay ticket para imprimir');
            return;
        }

        // Recopilar impresoras seleccionadas
        const impresorasSeleccionadas = [];
        checkboxes.forEach(checkbox => {
            impresorasSeleccionadas.push({
                id: checkbox.value,
                nombre: checkbox.dataset.nombre,
                ip: checkbox.dataset.ip,
                puerto: checkbox.dataset.puerto
            });
        });

        console.log('Imprimiendo en:', impresorasSeleccionadas);
        console.log('Ticket ID:', mesa.idTicket);

        // Enviar solicitud de impresión al servidor
        const response = await fetch(`${API_BASE}/tickets/${mesa.idTicket}/imprimir`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                impresoras: impresorasSeleccionadas.map(i => i.id),
                nombreEmpleado: empleadoActual ? empleadoActual.nombre : ''
            })
        });

        const result = await response.json();

        if (result.success) {
            cerrarModalImpresoras();
        }

    } catch (error) {
        console.error('Error al imprimir:', error);
        alert('Error al enviar la impresión');
    }
}

// =============================================
// DIÁLOGO MESA OCUPADA POR OTRO USUARIO
// =============================================

function mostrarDialogoMesaOcupada(idCliente, nombreOcupante) {
    const modal = document.getElementById('modal-mesa-ocupada');
    const mensaje = document.getElementById('modal-mesa-ocupada-mensaje');

    if (!modal) return;

    const nombreMesa = mesas[idCliente]?.nombre || `Mesa ${idCliente}`;
    mensaje.innerHTML = `La mesa <strong>${nombreMesa}</strong> está siendo usada por <strong>${nombreOcupante}</strong>.<br><br>¿Deseas entrar igualmente y expulsarle?`;

    modal.style.display = 'flex';

    // Clonar botones para limpiar listeners anteriores
    const btnEntrar = document.getElementById('btn-entrar-mesa-ocupada');
    const btnCancelar = document.getElementById('btn-cancelar-mesa-ocupada');

    const btnEntrarNuevo = btnEntrar.cloneNode(true);
    const btnCancelarNuevo = btnCancelar.cloneNode(true);
    btnEntrar.parentNode.replaceChild(btnEntrarNuevo, btnEntrar);
    btnCancelar.parentNode.replaceChild(btnCancelarNuevo, btnCancelar);

    btnEntrarNuevo.addEventListener('click', () => {
        modal.style.display = 'none';
        abrirMesa(idCliente, { forzar: true });
    });

    btnCancelarNuevo.addEventListener('click', () => {
        modal.style.display = 'none';
    });

    // Cerrar al hacer click en el fondo
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    }, { once: true });
}

function mostrarToastExpulsado(mensaje) {
    const toast = document.getElementById('toast-expulsado');
    if (!toast) return;

    toast.textContent = mensaje;
    toast.style.display = 'block';

    // Forzar reflow para que la transición CSS funcione
    void toast.offsetHeight;
    toast.classList.add('visible');

    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => {
            toast.style.display = 'none';
        }, 400);
    }, 4000);
}
