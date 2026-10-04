# Passwords are prompted without echo and passed only through process environment.
# Do not use Start-Transcript while running this script.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$taskVariables = @('NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SKILLCHECK_TEST_EMAIL_A', 'SKILLCHECK_TEST_PASSWORD_A',
  'SKILLCHECK_TEST_EMAIL_B', 'SKILLCHECK_TEST_PASSWORD_B')
$previousValues = @{}
foreach ($variableName in $taskVariables) {
  $previousValues[$variableName] = [Environment]::GetEnvironmentVariable($variableName, 'Process')
}
$taskExitCode = 1
try {
  $env:NEXT_PUBLIC_SUPABASE_URL = 'https://wsvjawuikxfzjyivxgsu.supabase.co'
  Write-Host 'SkillCheck: tylko odczyt API dwóch kont. Hasła nie będą wyświetlane ani zapisywane w plikach.'
  Write-Host 'Klucz publiczny projektu: Supabase > Project Settings > API Keys > Publishable key.'
  $publicKey = (Read-Host 'Klucz sb_publishable_ (nigdy secret/service_role)').Trim()
  if (-not $publicKey.StartsWith('sb_publishable_')) { throw 'Wymagany klucz publiczny sb_publishable_.' }
  $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = $publicKey
  foreach ($accountLabel in @('A', 'B')) {
    $accountEmail = (Read-Host "E-mail konta $accountLabel").Trim()
    if ($accountEmail -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { throw 'Niepoprawny format e-maila.' }
    [Environment]::SetEnvironmentVariable("SKILLCHECK_TEST_EMAIL_$accountLabel", $accountEmail, 'Process')
    $securePassword = Read-Host "Hasło konta $accountLabel (ukryte)" -AsSecureString
    $passwordPointer = [IntPtr]::Zero
    try {
      if ($securePassword.Length -eq 0) { throw 'Hasło nie może być puste.' }
      $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
      [Environment]::SetEnvironmentVariable("SKILLCHECK_TEST_PASSWORD_$accountLabel",
        [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer), 'Process')
    } finally {
      if ($passwordPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer) }
      $securePassword.Dispose()
    }
  }
  # No password in CLI arguments; no .env file created or loaded.
  & node (Join-Path $PSScriptRoot 'check-live-supabase.mjs')
  $taskExitCode = $LASTEXITCODE
} catch {
  Write-Host 'Test nie został ukończony. Sprawdź format danych i dostępność Node.js; nie przesyłaj haseł w czacie.'
} finally {
  foreach ($variableName in $taskVariables) {
    [Environment]::SetEnvironmentVariable($variableName, $previousValues[$variableName], 'Process')
  }
  $publicKey = $null
  $accountEmail = $null
}
exit $taskExitCode
