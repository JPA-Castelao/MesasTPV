# Configuración HTTPS para MesasTPV

## 📋 Resumen

Este proyecto ahora soporta HTTPS usando certificados SSL autofirmados para desarrollo local. Los certificados ya han sido generados y están listos para usar.

## 🚀 Uso

### Iniciar el servidor con HTTPS

Una vez generados los certificados, simplemente inicia el servidor normalmente:

```powershell
node server.js
```

El servidor detectará automáticamente los certificados en la carpeta `ssl/` y se iniciará en modo HTTPS.

Verás un mensaje como este:
```
🔐 Servidor HTTPS corriendo en https://localhost:3000
⚠️  Certificado autofirmado - el navegador mostrará advertencia de seguridad
```

### Acceder desde tu navegador

1. Abre tu navegador y ve a: `https://localhost:3000` (o el puerto que tengas configurado)
2. Verás una advertencia de seguridad del navegador
3. Haz clic en **"Avanzado"**
4. Haz clic en **"Continuar a localhost (no seguro)"**

### Acceder desde otros dispositivos (móvil, tablet)

1. Obtén la IP local de tu PC:
   ```powershell
   ipconfig
   ```
   Busca tu dirección IPv4, por ejemplo: `192.168.1.100`

2. En tu dispositivo móvil, abre el navegador y ve a:
   ```
   https://192.168.1.100:3000
   ```

3. Acepta la advertencia de seguridad en el móvil de la misma forma

## 🔄 Regenerar certificados

Si necesitas regenerar los certificados (por ejemplo, si expiraron después de 1 año):

```powershell
.\generate-ssl.ps1
```

Esto sobrescribirá los certificados existentes.

## 📁 Archivos generados

Los siguientes archivos se crean en la carpeta `ssl/`:

- `server.pfx` - Certificado PFX con clave privada (usado por el servidor)
- `server.cert` - Certificado público
- Password del PFX: `desarrollo`

## ⚠️ Importante

- Estos certificados son **solo para desarrollo local**
- **NO usar en producción**
- Los navegadores mostrarán advertencias porque es un certificado autofirmado
- Los certificados expiran después de 1 año
- Los archivos en la carpeta `ssl/` están excluidos de Git por seguridad

## 🔙 Volver a HTTP

Si por alguna razón necesitas volver a HTTP:

1. Elimina o renombra la carpeta `ssl/`
2. Reinicia el servidor

El servidor detectará que no hay certificados y se iniciará en modo HTTP:
```
🚀 Servidor HTTP corriendo en http://localhost:3000
💡 Para usar HTTPS, ejecuta: .\generate-ssl.ps1
```

## 🛠️ Solución de problemas

### Error: "unable to get local issuer certificate"
Esto es normal con certificados autofirmados. Acepta la advertencia del navegador.

### El navegador bloquea el acceso completamente
En Chrome/Edge, escribe `thisisunsafe` mientras estás en la página de advertencia (no aparecerá texto, pero funcionará).

### No se generan los certificados
Asegúrate de ejecutar PowerShell como Administrador si tienes problemas:
```powershell
PowerShell -ExecutionPolicy Bypass -File .\generate-ssl.ps1
```

## 📖 Referencias

- PowerShell usa `New-SelfSignedCertificate` para generar certificados
- El servidor usa el módulo nativo `https` de Node.js
- Soporte para archivos PFX y certificados OpenSSL (key/cert)
