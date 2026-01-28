# Script alternativo para generar certificados SSL usando PowerShell nativo

Write-Host "Generando certificado SSL autofirmado con PowerShell..." -ForegroundColor Cyan

# Crear directorio para certificados si no existe
$certDir = "ssl"
if (-not (Test-Path $certDir)) {
    New-Item -ItemType Directory -Path $certDir | Out-Null
    Write-Host "Carpeta 'ssl' creada" -ForegroundColor Green
}

try {
    # Crear certificado autofirmado usando PowerShell
    $cert = New-SelfSignedCertificate `
        -Subject "CN=localhost" `
        -DnsName "localhost", "127.0.0.1" `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -NotBefore (Get-Date) `
        -NotAfter (Get-Date).AddYears(1) `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -FriendlyName "MesasTPV Local SSL" `
        -HashAlgorithm SHA256 `
        -KeyUsage DigitalSignature, KeyEncipherment, DataEncipherment `
        -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.1")
    
    Write-Host "Certificado creado en el almacen de Windows" -ForegroundColor Green
    
    # Exportar la clave privada y el certificado
    $keyPath = Join-Path $certDir "server.key"
    $certPath = Join-Path $certDir "server.cert"
    $pfxPath = Join-Path $certDir "server.pfx"
    $password = ConvertTo-SecureString -String "desarrollo" -Force -AsPlainText
    
    # Exportar como PFX
    Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $password | Out-Null
    Write-Host "Certificado PFX exportado: $pfxPath" -ForegroundColor Green
    
    # Exportar certificado
    Export-Certificate -Cert $cert -FilePath $certPath | Out-Null
    Write-Host "Certificado exportado: $certPath" -ForegroundColor Green
    
    # Extraer clave privada (requiere OpenSSL, asi que usaremos PFX directamente)
    Write-Host ""
    Write-Host "Certificados creados exitosamente!" -ForegroundColor Green
    Write-Host "Certificado: $certPath" -ForegroundColor White
    Write-Host "PFX (clave + cert): $pfxPath" -ForegroundColor White
    Write-Host "Password PFX: desarrollo" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "IMPORTANTE: Este es un certificado autofirmado para desarrollo." -ForegroundColor Yellow
    Write-Host "Los navegadores mostraran una advertencia de seguridad." -ForegroundColor Yellow
    Write-Host ""
    
    # Limpiar del almacen
    Remove-Item -Path "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force
    
} catch {
    Write-Host "Error al crear el certificado: $_" -ForegroundColor Red
    exit 1
}
