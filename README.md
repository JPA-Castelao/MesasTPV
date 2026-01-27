# Gestión de Mesas - Cafetería

Aplicación web responsive para la gestión de mesas de una cafetería. Permite gestionar pedidos por mesa, añadir productos y cerrar cuentas.

## Características

- Interfaz responsive compatible con tablets
- Visualización de mesas en grid
- Gestión de pedidos por mesa
- Cálculo automático de totales
- Interfaz intuitiva y fácil de usar

## Estructura del Proyecto

```
.
├── index.html          # Página principal
├── css/
│   └── styles.css      # Estilos de la aplicación
├── js/
│   └── app.js          # Lógica de la aplicación
└── README.md           # Este archivo
```

## Cómo Usar

1. Clona este repositorio
2. Instala las dependencias:
   ```bash
   npm install
   ```
3. Inicia el servidor de desarrollo:
   ```bash
   npm run dev
   ```
4. Abre tu navegador en `http://localhost:8080`

## Uso de la Aplicación

1. En la pantalla principal verás una cuadrícula con las mesas disponibles
2. Haz clic en una mesa para abrir su gestión
3. En la ventana modal podrás:
   - Ver los productos disponibles
   - Añadir productos al pedido
   - Ver el pedido actual
   - Eliminar productos del pedido
   - Cerrar la cuenta

## Próximas Mejoras

- Integración con base de datos SQL Server
- Sistema de autenticación
- Historial de pedidos
- Gestión de inventario
- Impresión de tickets 