USE [ERP_TRIGAL_130126]
GO

IF OBJECT_ID('pTPV_Crear_Ticket_Comandas', 'P') IS NOT NULL 
    DROP PROCEDURE pTPV_Crear_Ticket_Comandas
GO

SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE PROCEDURE [dbo].[pTPV_Crear_Ticket_Comandas] 
    @iXML XML, 
    @oXML XML OUTPUT 
-- =============================================
-- #AUTHOR:     Fran
-- #NAME:       pTPV_Crear_Ticket_Comandas
-- #CREATION:   03/02/2026
-- #DESCRIPTION:
--              Crea un ticket en la caja indicada SIN DEPENDER DE LA SESIÓN DE AHORA
--              Basado en pTPV_Crear_Ticket pero obtiene los datos de la caja directamente
-- #PARAMETERS: 
--              @iXML
--                  IdCaja: Id de la caja que crea el Ticket
--                  IdCliente: (Opcional) Id del cliente, si no se pasa usa el de la caja
--                  IdEmpleado: (Opcional) Id del empleado
--              @oXML
--                  IdTicket: Valor de salida del IdTicket generado
-- =============================================
AS

DECLARE @vret INT

DECLARE @Numero INT
DECLARE @IdSerie T_Serie
DECLARE @IdMoneda T_Id_Moneda
DECLARE @IdLista T_Id_Lista
DECLARE @IdCliente T_Id_Cliente
DECLARE @IdClienteInput T_Id_Cliente
DECLARE @IdEmpleado INT
DECLARE @IdEmpleadoInput INT
DECLARE @IdEmpresaInput INT
DECLARE @IdContacto T_Id_Contacto
DECLARE @IdEmpresa T_Id_Empresa
DECLARE @IdFormaPago T_Forma_Pago
DECLARE @IdRepresentante T_Id_Empleado
DECLARE @IdContactoA T_Id_Contacto
DECLARE @Cambio T_Decimal
DECLARE @Hora VARCHAR(5)
DECLARE @Descuento T_Decimal
DECLARE @DescuentoPP T_Decimal
DECLARE @IdCaja T_Id_Caja
DECLARE @Usuario T_CEESI_Usuario = 'COMANDAS'
DECLARE @IdTicket INT = 0
DECLARE @Fecha SMALLDATETIME = GETDATE()
DECLARE @IdContactoP T_Id_Contacto

BEGIN TRY

    -- Obtener parámetros de entrada del XML
    SELECT 
        @IdCaja = T.C.value('IdCaja[1]', 'INT'),
        @IdClienteInput = T.C.value('IdCliente[1]', 'VARCHAR(20)'),
        @IdEmpleadoInput = T.C.value('IdEmpleado[1]', 'INT'),
        @IdEmpresaInput = T.C.value('IdEmpresa[1]', 'INT')
    FROM @iXML.nodes('/data') T(C)

    -- Validar IdCaja
    IF @IdCaja IS NULL OR @IdCaja = 0
        RAISERROR('IdCaja es obligatorio', 16, 1)

    -- Obtener datos de la caja
    SELECT 
        @IdSerie = C.IdSerie,
        @IdMoneda = C.IdMoneda,
        @IdLista = C.IdLista,
        @IdCliente = CASE 
            WHEN @IdClienteInput IS NOT NULL AND @IdClienteInput <> '' AND @IdClienteInput <> '0'
            THEN @IdClienteInput 
            ELSE C.IdCliente 
        END,
        @IdFormaPago = FP.IdFormaPago,
        @IdEmpleado = ISNULL(@IdEmpleadoInput, C.IdEmpleado),
        @Cambio = ISNULL((SELECT Cambio FROM dbo.funDameCambioMoneda(C.IdMoneda, CONVERT(SMALLDATETIME, GETDATE(), 112))), 1),
        @Hora = CONVERT(VARCHAR(5), GETDATE(), 108)
    FROM Cajas C
        LEFT JOIN Cajas_FormasDePago FP ON FP.IdCaja = C.IdCaja AND FP.DefectoCaja = 1
    WHERE C.IdCaja = @IdCaja

    -- Obtener IdEmpresa del XML o de la tabla Empresa
    IF @IdEmpresaInput IS NOT NULL AND @IdEmpresaInput > 0
        SET @IdEmpresa = @IdEmpresaInput
    ELSE
        SELECT TOP 1 @IdEmpresa = IdEmpresa FROM Empresa

    IF @IdSerie IS NULL
        RAISERROR('No se encontró configuración para la caja %d', 16, 1, @IdCaja)

    -- Obtener número siguiente
    SELECT @Numero = ISNULL(MAX(Numero), 0) + 1 FROM Tickets WHERE IdSerie = @IdSerie

    -- Obtener datos del cliente
    SELECT 
        @IdRepresentante = ISNULL(CDC.IdEmpleado, @IdEmpleado), 
        @IdContacto = CASE WHEN CD.Nivel = 1 THEN CD.IdContactoCliente ELSE CD.IdContactoF END, 
        @IdContactoA = CD.IdContactoA, 
        @IdContactoP = CD.IdContacto, 
        @Descuento = ISNULL(CDE.Descuento, 0),
        @DescuentoPP = ISNULL(CDE.ProntoPago, 0)
    FROM Clientes_Datos CD
        LEFT JOIN Clientes_Datos_Comerciales CDC ON CDC.IdCliente = CD.IdCliente
        LEFT JOIN Clientes_Datos_Economicos CDE ON CDE.IdCliente = CD.IdCliente
    WHERE CD.IdCliente = @IdCliente

    -- Si no se encontró representante, usar el empleado
    IF @IdRepresentante IS NULL OR @IdRepresentante = 0
        SET @IdRepresentante = @IdEmpleado

    -- Si no hay empleado, usar 1 por defecto
    IF @IdEmpleado IS NULL OR @IdEmpleado = 0
        SET @IdEmpleado = 1

    -- Cliente no debe estar bloqueado
    IF EXISTS(SELECT 1 FROM Clientes_Datos WHERE IdCliente = @IdCliente AND Bloqueado = 1) 
        RAISERROR('No es posible generar un ticket a un cliente bloqueado', 16, 1)

    BEGIN TRAN 
        ------------------------------------------
        -- Insertar el registro 
        ------------------------------------------
        EXECUTE @vret = [dbo].[PTickets_I] 
            @IdTicket OUTPUT,
            @IdCaja OUTPUT,
            @IdSerie OUTPUT,
            @Numero OUTPUT,
            @Fecha OUTPUT,
            @IdEmpleado OUTPUT,
            @IdCliente OUTPUT,
            @Observaciones = 'Ticket Comandas',
            @IdEstado = 0,
            @IdRepresentante = @IdRepresentante,
            @IdPedido = 0,
            @IdFormaPago = @IdFormaPago,
            @Referencia = NULL,
            @ReferenciaTQ = NULL,
            @IdContacto = @IdContacto,
            @Descuento = @Descuento,
            @IdEmpresa = @IdEmpresa,
            @DescuentoPP = @DescuentoPP,
            @IdLista = @IdLista,
            @NumPedidoCli = NULL,
            @HoraIni = @Hora,
            @FechaDev = NULL,
            @HoraDev = NULL,
            @Fianza = 0,
            @FPago_Fianza = 0,
            @IdContrato = NULL,
            @FechaEstDev = NULL,
            @ExcluirDias = 0,
            @IdProyecto = NULL,
            @DescartarLineas = 0,
            @IdPedido_Abono = NULL,
            @IdOferta = NULL,
            @Revision = NULL,
            @Entregado = NULL,
            @Devuelto = NULL,
            @IdMoneda = @IdMoneda,
            @Cambio = @Cambio,
            @IdOperacion = 0,
            @IdProveedor = NULL,
            @IdAlmacenTraspaso = NULL,
            @IdEnvio = NULL,
            @EsAlbaranRecepcion = 0,
            @IdContactoA = @IdContactoA,
            @IdContactoP = @IdContactoP,
            @IdDoc = NULL,
            @Usuario = @Usuario,
            @FechaInsertUpdate = @Fecha

    COMMIT TRAN 
    
    -- Verificamos creación
    IF ISNULL(@IdTicket, 0) = 0 
        RAISERROR('No ha sido posible crear el ticket', 16, 1)

    SELECT @oXML = '<Resultado><Respuesta><Estado>ok</Estado></Respuesta><data><IdTicket>' + CAST(@IdTicket AS VARCHAR(20)) + '</IdTicket></data><view /></Resultado>'

    RETURN -1

END TRY
BEGIN CATCH

    IF @@TRANCOUNT > 0 ROLLBACK TRAN 
 
    DECLARE @CatchError NVARCHAR(MAX) = ERROR_MESSAGE()
    DECLARE @err_state INT = ERROR_STATE()
    DECLARE @err_severity INT = ERROR_SEVERITY()
    
    RAISERROR(@CatchError, @err_severity, @err_state)
 
    RETURN 0

END CATCH
GO
zpermisos pTPV_Crear_Ticket_Comandas




