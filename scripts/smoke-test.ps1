<#
.SYNOPSIS
    mSpace smoke tests (Windows / PowerShell).

.DESCRIPTION
    Verifies credentials, the allowed-host-address list, and every endpoint you
    have configured.

    Only the services with a URL set in your environment are tested — an unset
    endpoint means that API is not enabled on your application, so there is
    nothing to test. Configure them in .env; see templates/.env.example.

    RUN THIS FROM THE SERVER THAT WILL CALL mSPACE. Running it from a laptop
    tests the laptop's IP, which is not what you put in Allowed Host Address.

    Credentials come from the environment. Never paste them into this file.

.EXAMPLE
    .\scripts\smoke-test.ps1

.EXAMPLE
    .\scripts\smoke-test.ps1 -WithSms -TestMsisdn 94702725777
#>
[CmdletBinding()]
param(
    [switch]$WithSms,
    [switch]$WithCharge,
    [switch]$WithLbs,
    [string]$TestMsisdn = $(if ($env:TEST_MSISDN) { $env:TEST_MSISDN } else { "94702725777" })
)

# Load .env if present (KEY=VALUE lines, skipping comments).
if (Test-Path .env) {
    Get-Content .env | ForEach-Object {
        if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') {
            Set-Item -Path "env:$($Matches[1])" -Value $Matches[2].Trim('"').Trim()
        }
    }
}

if (-not $env:MSPACE_APP_ID)   { throw "Set MSPACE_APP_ID (see templates/.env.example)" }
if (-not $env:MSPACE_PASSWORD) { throw "Set MSPACE_PASSWORD (see templates/.env.example)" }

$script:Pass = 0
$script:Fail = 0
$script:Skip = 0

function Skip-Test {
    param([string]$Name, [string]$Reason)
    Write-Host ("{0,-30}" -f $Name) -NoNewline
    Write-Host $Reason -ForegroundColor DarkGray
    $script:Skip++
}

function Invoke-MspaceCall {
    param([string]$Name, [string]$Url, [hashtable]$Body, [string]$ExtraSuccess = "")

    Write-Host ("{0,-30}" -f $Name) -NoNewline

    $payload = ($Body + @{
        applicationId = $env:MSPACE_APP_ID
        password      = $env:MSPACE_PASSWORD
    }) | ConvertTo-Json -Depth 5 -Compress

    try {
        $response = Invoke-RestMethod -Uri $Url -Method Post `
            -ContentType 'application/json;charset=utf-8' -Body $payload -TimeoutSec 20
    }
    catch {
        Write-Host "NO RESPONSE" -ForegroundColor Red -NoNewline
        Write-Host "  $($_.Exception.Message)" -ForegroundColor DarkGray
        $script:Fail++
        return
    }

    if ($ExtraSuccess -and $response.statusCode -eq $ExtraSuccess) {
        Write-Host "$($response.statusCode) OK" -ForegroundColor Green -NoNewline
        Write-Host "  (documented success for this call)" -ForegroundColor DarkGray
        $script:Pass++
        return
    }

    switch -Regex ($response.statusCode) {
        '^S1000$' { Write-Host "S1000 OK" -ForegroundColor Green; $script:Pass++ }
        '^S1001$' { Write-Host "S1001  No subscribers found (a success)" -ForegroundColor Green; $script:Pass++ }
        '^P1003$' { Write-Host "P1003  OTP sent - nothing charged yet" -ForegroundColor Green; $script:Pass++ }
        '^E1303$' { Write-Host "E1303" -ForegroundColor Red -NoNewline
                    Write-Host "  This IP is not in Allowed Host Address on the application" -ForegroundColor DarkGray
                    $script:Fail++ }
        '^E1313$' { Write-Host "E1313" -ForegroundColor Red -NoNewline
                    Write-Host "  Auth failure - check MSPACE_APP_ID / MSPACE_PASSWORD" -ForegroundColor DarkGray
                    $script:Fail++ }
        '^E1309$' { Write-Host "E1309" -ForegroundColor Yellow -NoNewline
                    Write-Host "  Service not provisioned - remove this URL from your .env" -ForegroundColor DarkGray
                    $script:Fail++ }
        '^E1104$' { Write-Host "E1104" -ForegroundColor Yellow -NoNewline
                    Write-Host "  Application is not in Active or Limited Production status" -ForegroundColor DarkGray
                    $script:Fail++ }
        '^E1343$' { Write-Host "E1343" -ForegroundColor Yellow -NoNewline
                    Write-Host "  $TestMsisdn is not in Whitelisted Numbers" -ForegroundColor DarkGray
                    $script:Fail++ }
        default   { Write-Host "$($response.statusCode)" -ForegroundColor Red -NoNewline
                    $detail = if ($response.statusDetail) { $response.statusDetail } else { $response.statusDescription }
                    Write-Host "  $detail" -ForegroundColor DarkGray
                    $script:Fail++ }
    }
}

Write-Host ""
Write-Host "mSpace smoke test"
Write-Host "  app id     $($env:MSPACE_APP_ID)"
Write-Host "  password   ***redacted***"
Write-Host "  Run this on the server that will call mSpace: its egress IP is what must be" -ForegroundColor DarkGray
Write-Host "  listed under Allowed Host Address on the application record." -ForegroundColor DarkGray
Write-Host ""

Write-Host "-- Subscription --------------------------------"
if ($env:MSPACE_SUBSCRIPTION_QUERY_BASE_URL) {
    Invoke-MspaceCall "Query Base (base size)" $env:MSPACE_SUBSCRIPTION_QUERY_BASE_URL @{}
} else { Skip-Test "Query Base (base size)" "MSPACE_SUBSCRIPTION_QUERY_BASE_URL not set" }

if ($env:MSPACE_SUBSCRIPTION_STATUS_URL) {
    Invoke-MspaceCall "Subscriber Status" $env:MSPACE_SUBSCRIPTION_STATUS_URL @{ subscriberId = "tel:$TestMsisdn" }
} else { Skip-Test "Subscriber Status" "MSPACE_SUBSCRIPTION_STATUS_URL not set" }

if ($env:MSPACE_SUBSCRIPTION_CHARGING_INFO_URL) {
    Invoke-MspaceCall "Subscriber Charging Info" $env:MSPACE_SUBSCRIPTION_CHARGING_INFO_URL @{ subscriberIds = @("tel:$TestMsisdn") }
} else { Skip-Test "Subscriber Charging Info" "MSPACE_SUBSCRIPTION_CHARGING_INFO_URL not set" }

if ($env:MSPACE_SUBSCRIPTION_LIST_URL) {
    Invoke-MspaceCall "Subscriber List (page 1)" $env:MSPACE_SUBSCRIPTION_LIST_URL @{ version = "1.0"; requestPage = 1 } "S1001"
} else { Skip-Test "Subscriber List (page 1)" "MSPACE_SUBSCRIPTION_LIST_URL not set" }

if ($env:MSPACE_SUBSCRIPTION_SEND_URL) {
    Invoke-MspaceCall "Register (opt-in)"    $env:MSPACE_SUBSCRIPTION_SEND_URL @{ subscriberId = "tel:$TestMsisdn"; action = "1" }
    Invoke-MspaceCall "Unregister (opt-out)" $env:MSPACE_SUBSCRIPTION_SEND_URL @{ subscriberId = "tel:$TestMsisdn"; action = "0" }
} else { Skip-Test "Register / Unregister" "MSPACE_SUBSCRIPTION_SEND_URL not set" }

Write-Host ""
Write-Host "-- CaaS ----------------------------------------"
if (-not $env:MSPACE_CAAS_DEBIT_URL) {
    Skip-Test "CaaS OTP Generation" "MSPACE_CAAS_DEBIT_URL not set"
} elseif (-not $WithCharge) {
    Skip-Test "CaaS OTP Generation" "skipped (-WithCharge to run - starts a real charge)"
} else {
    Write-Host "  !! This starts a REAL charge against $TestMsisdn and sends them an OTP." -ForegroundColor Yellow
    Write-Host "     Money moves only when that OTP is verified - see references/06-caas.md." -ForegroundColor Yellow
    $trxId = [guid]::NewGuid().ToString("N")
    Write-Host "  externalTrxId: $trxId  (persist this before charging, in real code)" -ForegroundColor DarkGray
    Invoke-MspaceCall "CaaS OTP Generation (LKR 1)" $env:MSPACE_CAAS_DEBIT_URL @{
        externalTrxId         = $trxId
        subscriberId          = "tel:$TestMsisdn"
        paymentInstrumentName = "Mobile Account"
        amount                = "1.00"
        currency              = "LKR"
    } "P1003"
    Write-Host "  Take requestCorrelator from the response above, collect the OTP from the" -ForegroundColor DarkGray
    Write-Host "  subscriber, then POST it to MSPACE_CAAS_OTP_VERIFY_URL as referenceNo." -ForegroundColor DarkGray
}

if (-not $env:MSPACE_CAAS_OTP_VERIFY_URL) {
    Skip-Test "CaaS OTP Verification" "MSPACE_CAAS_OTP_VERIFY_URL not set"
} else {
    Skip-Test "CaaS OTP Verification" "needs a live requestCorrelator and a real OTP - run it by hand"
}

Write-Host ""
Write-Host "-- SMS -----------------------------------------"
if (-not $env:MSPACE_SMS_SEND_URL) {
    Skip-Test "SMS Send" "MSPACE_SMS_SEND_URL not set"
} elseif (-not $WithSms) {
    Skip-Test "SMS Send" "skipped (-WithSms to run - sends a real SMS)"
} else {
    Invoke-MspaceCall "SMS Send" $env:MSPACE_SMS_SEND_URL @{
        version              = "1.0"
        message              = "mSpace smoke test"
        destinationAddresses = @("tel:$TestMsisdn")
    }
}

Write-Host ""
Write-Host "-- LBS -----------------------------------------"
if (-not $env:MSPACE_LBS_REQUEST_URL) {
    Skip-Test "Request Location" "MSPACE_LBS_REQUEST_URL not set"
} elseif (-not $WithLbs) {
    Skip-Test "Request Location" "skipped (-WithLbs to run - requires consent)"
} else {
    Invoke-MspaceCall "Request Location" $env:MSPACE_LBS_REQUEST_URL @{
        requesterId  = "tel:$TestMsisdn"
        subscriberId = "tel:$TestMsisdn"
        serviceType  = "IMMEDIATE"
    }
}

Write-Host ""
Write-Host "-----------------------------------------------"
Write-Host "  passed $($script:Pass)" -ForegroundColor Green -NoNewline
Write-Host "   failed $($script:Fail)" -ForegroundColor Red -NoNewline
Write-Host "   skipped $($script:Skip)" -ForegroundColor DarkGray
if ($script:Pass -eq 0 -and $script:Fail -eq 0) {
    Write-Host "  Nothing ran - no service endpoints are configured in .env." -ForegroundColor Yellow
}
Write-Host ""

if ($script:Fail -gt 0) { exit 1 }
