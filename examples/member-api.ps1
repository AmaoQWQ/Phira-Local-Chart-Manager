# Dot-source this file to load the helpers. No requests run until a function is called.
# Windows PowerShell 5.1 / PowerShell 7. Credentials and cookies stay in memory.
function Connect-PhiraGateway {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BaseUrl,
        [Parameter(Mandatory)][System.Management.Automation.PSCredential]$Credential
    )
    $baseUri = [Uri]$BaseUrl
    if (-not $baseUri.IsAbsoluteUri -or $baseUri.Scheme -notin @('https', 'http') -or $baseUri.UserInfo -or $baseUri.AbsolutePath -ne '/' -or $baseUri.Query -or $baseUri.Fragment) {
        throw 'BaseUrl must be the gateway origin, for example https://charts.example.com:8443'
    }
    $origin = $baseUri.GetLeftPart([UriPartial]::Authority)
    $body = @{
        username = $Credential.UserName
        password = $Credential.GetNetworkCredential().Password
    } | ConvertTo-Json -Compress
    $login = Invoke-RestMethod -Uri "$origin/api/admin/auth/login" -Method Post `
        -ContentType 'application/json; charset=utf-8' `
        -Headers @{ 'X-Admin-Request' = '1' } `
        -Body ([Text.Encoding]::UTF8.GetBytes($body)) -SessionVariable gatewaySession
    # Assign the returned object to a variable; it contains the active session.
    [pscustomobject]@{ BaseUrl = $origin; Session = $gatewaySession; Csrf = $login.csrf; User = $login.user }
}

function Invoke-PhiraAdmin {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Connection,
        [Parameter(Mandatory)][string]$Path,
        [ValidateSet('GET', 'POST', 'PATCH', 'PUT', 'DELETE')][string]$Method = 'GET',
        [object]$Body,
        [string]$Reason,
        [string]$Confirm,
        [string]$OutFile
    )
    if ($Path -notmatch '^/api/admin(?:/|\?|$)' -or $Path.Contains('#')) {
        throw 'Path must begin with /api/admin and must not contain a URL fragment'
    }
    $headers = @{ 'X-Admin-Request' = '1'; 'X-CSRF-Token' = $Connection.Csrf }
    if ($Reason) { $headers['X-Admin-Reason'] = [Uri]::EscapeDataString($Reason) }
    if ($Confirm) { $headers['X-Admin-Confirm'] = $Confirm }
    $request = @{
        Uri = $Connection.BaseUrl + $Path
        Method = $Method
        WebSession = $Connection.Session
        Headers = $headers
        TimeoutSec = 600
    }
    if ($PSBoundParameters.ContainsKey('Body')) {
        $request.ContentType = 'application/json; charset=utf-8'
        $request.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 20 -Compress))
    }
    if ($OutFile) { $request.OutFile = $OutFile }
    Invoke-RestMethod @request
}

function Send-PhiraChart {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Connection,
        [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9_-]{0,47}$')][string]$Instance,
        [Parameter(Mandatory)][string]$File,
        [int]$ChartId
    )
    $filePath = (Resolve-Path -LiteralPath $File -ErrorAction Stop).ProviderPath
    $body = @{ packageBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($filePath)) }
    if ($PSBoundParameters.ContainsKey('ChartId')) { $body.id = $ChartId }
    Invoke-PhiraAdmin -Connection $Connection -Path "/api/admin/charts?instance=$Instance" -Method POST -Body $body
}
