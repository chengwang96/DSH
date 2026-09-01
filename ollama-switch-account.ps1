#requires -Version 5.1
<#
.SYNOPSIS
  在两个 ollama.com 订阅账号之间快速切换。

.DESCRIPTION
  原理：ollama 的账号不是靠 token 文件，而是通过设备密钥对
  ~/.ollama/id_ed25519 (+ .pub) 绑定到 ollama.com（`ollama signin` 打开
  ollama.com/connect 用公钥绑定，云端请求用私钥签名鉴权）。
  所以切换账号 = 替换这份密钥对 + 重启 ollama。

  本脚本把两个账号的密钥对各存一份（~/.ollama/accounts/a 和 b），
  一键切换并重启。

用法：
  .\ollama-switch-account.ps1 setup    # 一次性：保存当前账号为 a，生成 b 的密钥并提示绑定
  .\ollama-switch-account.ps1 a        # 切换到账号 a
  .\ollama-switch-account.ps1 b        # 切换到账号 b
  .\ollama-switch-account.ps1 status   # 显示当前使用哪个账号
  .\ollama-switch-account.ps1 list     # 列出已保存的账号密钥
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('setup', 'a', 'b', 'status', 'list')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

# 允许测试时用环境变量指向临时目录，避免动到真实 ~/.ollama
$ollamaDir = if ($env:OLLAMA_SWITCH_HOME) { $env:OLLAMA_SWITCH_HOME } else { Join-Path $env:USERPROFILE '.ollama' }
$accountsDir = Join-Path $ollamaDir 'accounts'
$keyPriv = Join-Path $ollamaDir 'id_ed25519'
$keyPub = Join-Path $ollamaDir 'id_ed25519.pub'

function Test-Keypair([string]$dir) {
  return ((Test-Path (Join-Path $dir 'id_ed25519')) -and (Test-Path (Join-Path $dir 'id_ed25519.pub')))
}

function Save-Keypair([string]$dstDir) {
  if (-not (Test-Path $keyPriv) -or -not (Test-Path $keyPub)) {
    throw "当前没有找到密钥对：$keyPriv / $keyPub（ollama 还没生成过？先启动一次 ollama）"
  }
  New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
  Copy-Item $keyPriv (Join-Path $dstDir 'id_ed25519') -Force
  Copy-Item $keyPub (Join-Path $dstDir 'id_ed25519.pub') -Force
}

function Restore-Keypair([string]$srcDir) {
  if (-not (Test-Keypair $srcDir)) { throw "账号目录缺少密钥对：$srcDir" }
  Copy-Item (Join-Path $srcDir 'id_ed25519') $keyPriv -Force
  Copy-Item (Join-Path $srcDir 'id_ed25519.pub') $keyPub -Force
}

function Get-Fingerprint([string]$pubPath) {
  if (-not (Test-Path $pubPath)) { return '(none)' }
  $lf = (& ssh-keygen -lf $pubPath 2>$null) -join ' '
  if ($lf -match 'SHA256:([A-Za-z0-9+/=]+)') { return 'SHA256:' + $Matches[1] }
  # 回退：取 base64 尾部（所有 ed25519 公钥共享同一前缀，不能用开头区分）
  $line = (Get-Content $pubPath -Raw).Trim()
  $parts = $line -split '\s+'
  if ($parts.Count -ge 2) {
    $b64 = $parts[1]
    return '...' + $b64.Substring([Math]::Max(0, $b64.Length - 20))
  }
  return '...' + $line.Substring([Math]::Max(0, $line.Length - 20))
}

function Restart-Ollama {
  if ($env:OLLAMA_SWITCH_HOME) {
    Write-Host '(测试模式：跳过重启)' -ForegroundColor DarkGray
    return
  }
  Write-Host '正在重启 ollama...' -ForegroundColor Yellow
  Stop-Process -Name 'ollama app' -Force -ErrorAction SilentlyContinue
  Stop-Process -Name 'ollama' -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  $appPath = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama app.exe'
  if (Test-Path $appPath) {
    Start-Process $appPath
    Write-Host '已重新启动 Ollama 应用。' -ForegroundColor Green
  } else {
    Write-Host '未找到 Ollama 应用，请手动启动。' -ForegroundColor Red
  }
  Start-Sleep -Seconds 2
}

switch ($Action) {
  'setup' {
    $dirA = Join-Path $accountsDir 'a'
    $dirB = Join-Path $accountsDir 'b'

    if (-not (Test-Keypair $dirA)) {
      Write-Host '保存当前密钥对为账号 a（即当前已绑定的账号）...' -ForegroundColor Cyan
      Save-Keypair $dirA
      Write-Host "  账号 a 指纹: $(Get-Fingerprint (Join-Path $dirA 'id_ed25519.pub'))"
    } else {
      Write-Host '账号 a 已存在，跳过。' -ForegroundColor DarkGray
    }

    if (-not (Test-Keypair $dirB)) {
      Write-Host '生成账号 b 的新密钥对...' -ForegroundColor Cyan
      New-Item -ItemType Directory -Force -Path $dirB | Out-Null
      $tmpPriv = Join-Path $dirB 'id_ed25519'
      $tmpPub = Join-Path $dirB 'id_ed25519.pub'
      & ssh-keygen -t ed25519 -f $tmpPriv -N '""' -C 'ollama-account-b' -q 2>$null
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tmpPriv)) {
        throw 'ssh-keygen 生成失败。请确认已安装 OpenSSH 客户端（Windows 10+ 自带）。'
      }
      # ssh-keygen 生成的公钥文件名是 .pub，且私钥无扩展名，正合 ollama 命名
      Write-Host "  账号 b 指纹: $(Get-Fingerprint $tmpPub)"
    } else {
      Write-Host '账号 b 已存在，跳过。' -ForegroundColor DarkGray
    }

    # 把 b 的密钥放到 ~/.ollama，让用户用 ollama signin 绑定账号 B
    Write-Host ''
    Write-Host '切换到账号 b 的密钥，准备绑定...' -ForegroundColor Cyan
    Restore-Keypair $dirB
    Write-Host ''
    Write-Host '=== 下一步（手动，只需做一次）===' -ForegroundColor Yellow
    Write-Host '  现在运行：  ollama signin'
    Write-Host '  浏览器会打开 ollama.com，用你的【第二个账号】登录并授权。'
    Write-Host '  授权后，账号 B 就绑定到了 b 的密钥。'
    Write-Host '  以后用  .\ollama-switch-account.ps1 a / b  即可来回切换。'
  }

  { $_ -in 'a', 'b' } {
    $dir = Join-Path $accountsDir $_
    if (-not (Test-Keypair $dir)) {
      throw "账号 $_ 还没保存密钥。先运行 .\ollama-switch-account.ps1 setup 完成一次性配置。"
    }
    Write-Host "切换到账号 $_ ..." -ForegroundColor Cyan
    Restore-Keypair $dir
    Write-Host "  指纹: $(Get-Fingerprint (Join-Path $dir 'id_ed25519.pub'))"
    Restart-Ollama
    Write-Host "已切换到账号 $_。" -ForegroundColor Green
  }

  'status' {
    $cur = Get-Fingerprint $keyPub
    Write-Host "当前 ~/.ollama 密钥指纹: $cur"
    foreach ($n in @('a', 'b')) {
      $d = Join-Path $accountsDir $n
      if (Test-Keypair $d) {
        $fp = Get-Fingerprint (Join-Path $d 'id_ed25519.pub')
        $mark = if ($fp -eq $cur) { '  <== 当前' } else { '' }
        Write-Host "  账号 $n : $fp$mark"
      }
    }
  }

  'list' {
    foreach ($n in @('a', 'b')) {
      $d = Join-Path $accountsDir $n
      if (Test-Keypair $d) {
        Write-Host "账号 $n : $(Get-Fingerprint (Join-Path $d 'id_ed25519.pub'))"
      } else {
        Write-Host "账号 $n : (未保存)"
      }
    }
  }
}
