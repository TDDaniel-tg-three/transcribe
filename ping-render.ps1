$url = "https://transcribe-bot-0oiu.onrender.com"
try {
    Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30 | Out-Null
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Ping OK - $url"
} catch {
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Error: $_"
}
