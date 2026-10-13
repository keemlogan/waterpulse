<#
  bootstrap.ps1 - WaterPulse: rebuild the course VM on a freshly reset lab PC (Windows PowerShell 5.1, no admin needed).

  Steps (each one is skipped when its result already exists, so it is safe to re-run):
    1  download the professor's Dropbox zip (SHA256 check)
    2  extract to <Root>\vm, set vmx memsize/numvcpus
    3  create + attach the 100GB data disk (wp_data.vmdk), power on, find the guest IP
    4  create an RSA-2048 key and install it in the guest (vmrun guest ops), check password-less ssh
    5  download code/vm (GitHub <Commit>) + data bundle (release data-v1, SHA256 check), copy into the guest
    6  run 00_vm_bootstrap.sh -> run_step1_raw.sh -> run_step2_clean_compare_spark.sh over ssh

  Examples:
    .\bootstrap.ps1                                   # full rebuild into E:\WaterPulse
    .\bootstrap.ps1 -Root E:\WaterPulse_test -MemMB 6144 -Steps 1,2,3,4    # trial next to a running VM
    .\bootstrap.ps1 -Steps 6 -Commit 380be90          # re-run only the VM-side pipeline

  Lessons baked in (measured on this PC, 2026-10-13):
    - vmrun lives in C:\Program Files\VMware\VMware Workstation (not x86)
    - CentOS 6 guest hangs at boot with 8 vCPU on this Hyper-V host -> use 4
    - the guest's old sshd needs -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa
    - Windows scp needs -O (legacy protocol) for recursive copies to CentOS 6
    - PowerShell 5.1 strips double quotes inside native arguments -> send scripts as files, not inline
#>
param(
    [string]$Root   = 'E:\WaterPulse',
    [int]$MemMB     = 16384,
    [int]$Cpus      = 4,
    [string]$Commit = 'main',
    [string]$Steps  = '1,2,3,4,5,6',      # comma list; a string so it also works with powershell -File
    [int]$DiskGB    = 100
)
# 'Continue': with 'Stop', PS 5.1 turns any native-command stderr line (ssh/scp retries) into a fatal error.
# Failures are detected explicitly via $LASTEXITCODE and Fail.
$ErrorActionPreference = 'Continue'
$StepList = @($Steps -split '[,\s]+' | Where-Object { $_ } | ForEach-Object { [int]$_ })
$DropboxUrl = 'https://www.dropbox.com/s/jwfk7pd6e8o3hdw/Cloudera-Training-CAPSpark-Student-VM-cdh5.4.3a-vmware.zip?dl=1'
$VmZipSha   = '25B497156F39EA70615CD338C48E7993B410B767292D604183EC2E86E66EB809'
$DataUrl    = 'https://github.com/keemlogan/waterpulse/releases/download/data-v1/wp_sample_v1.tar'
$DataSha    = 'D5CA6ECE5A5C137B27B0E647AB69F53591D138E75F9BA40C8649E4C3987C7332'
$VMW        = 'C:\Program Files\VMware\VMware Workstation'
$vmrun      = "$VMW\vmrun.exe"
$vdm        = "$VMW\vmware-vdiskmanager.exe"
$VmName     = 'Cloudera-Training-CAPSpark-Student-VM-cdh5.4.3a-vmware'

foreach ($d in 'download', 'vm', 'keys', 'logs', 'repo', 'data') { New-Item -ItemType Directory -Force "$Root\$d" | Out-Null }
$Log   = "$Root\logs\bootstrap_$(Get-Date -f yyyyMMdd_HHmmss).log"
$Zip   = "$Root\download\$VmName.zip"
$VmDir = "$Root\vm\$VmName"
$Vmx   = "$VmDir\cloudera-training-capspark-student-rev_cdh5.4.3a.vmx"
$Key   = "$Root\keys\wp_vm_rsa"
$Known = "$Root\keys\known_hosts"
$IpFile = "$Root\keys\guest_ip.txt"
$t0 = Get-Date

function Log($m) { $line = "{0} [{1,6:N1} min] {2}" -f (Get-Date -f HH:mm:ss), ((Get-Date) - $t0).TotalMinutes, $m; $line | Tee-Object -Append $Log }
function Fail($m) { Log "FAILED: $m"; throw $m }
function Sha($f) { (Get-FileHash $f -Algorithm SHA256).Hash }
function SshOpts { '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'HostKeyAlgorithms=+ssh-rsa', '-o', 'PubkeyAcceptedAlgorithms=+ssh-rsa',
                   '-o', 'StrictHostKeyChecking=accept-new', '-o', "UserKnownHostsFile=$Known", '-i', $Key }
function Target { "training@$((Get-Content $IpFile -ErrorAction Stop).Trim())" }
function Guest($cmd) { $o = SshOpts; & ssh.exe -n @o (Target) $cmd }
function ToGuest($src, $dst, [switch]$Recurse) { $o = SshOpts; if ($Recurse) { & scp.exe -O @o -r $src "$(Target):$dst" } else { & scp.exe -O @o $src "$(Target):$dst" }; if ($LASTEXITCODE) { Fail "scp $src" } }
function Download($url, $out) {
    # resilient download: abort a stalled connection (<10 KB/s for 60 s) and retry, resuming the partial file
    for ($i = 1; $i -le 5; $i++) {
        curl.exe -L --fail -sS -C - --speed-limit 10240 --speed-time 60 --connect-timeout 30 -o $out $url
        if ($LASTEXITCODE -eq 0) { return }
        if ($LASTEXITCODE -eq 33) { Remove-Item $out -Force -ErrorAction SilentlyContinue }   # server refused resume -> restart
        Log "  download attempt $i failed (curl exit $LASTEXITCODE), retrying"; Start-Sleep 5
    }
    Fail "download $url"
}
function VmRunning { (& $vmrun -T ws list) -contains $Vmx }
function Step($n, $title) { if ($StepList -notcontains $n) { Log "-- step ${n} skipped ($title)" | Out-Host; return $false }; Log "== step ${n}: $title" | Out-Host; return $true }

trap { Log "UNEXPECTED ERROR: $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)"; break }
Log "bootstrap start: Root=$Root MemMB=$MemMB Cpus=$Cpus Commit=$Commit Steps=$($StepList -join ',')"
if (-not (Test-Path $vmrun)) { Fail "VMware Workstation not found at $VMW" }

# 1) professor's VM zip
if (Step 1 'download VM zip') {
    if ((Test-Path $Zip) -and (Sha $Zip) -eq $VmZipSha) { Log 'zip already present, SHA256 ok' }
    else {
        Download $DropboxUrl $Zip
        $h = Sha $Zip; Log "zip $((Get-Item $Zip).Length) bytes sha256=$h"
        if ($h -ne $VmZipSha) { Fail "VM zip SHA256 mismatch (expected $VmZipSha)" }
    }
}

# 2) extract + resize
if (Step 2 'extract VM, set memory/CPU') {
    if (-not (Test-Path $Vmx)) { tar.exe -xf $Zip -C "$Root\vm"; if ($LASTEXITCODE) { Fail 'extract' }; Log 'extracted' } else { Log 'VM folder already present' }
    if (VmRunning) { Log 'VM is running - memsize/numvcpus left unchanged' }
    else {
        if (-not (Test-Path "$Vmx.orig")) { Copy-Item $Vmx "$Vmx.orig" }
        $v = [IO.File]::ReadAllText($Vmx)
        $v = $v -replace 'memsize = "\d+"', "memsize = `"$MemMB`"" -replace 'numvcpus = "\d+"', "numvcpus = `"$Cpus`""
        [IO.File]::WriteAllText($Vmx, $v, (New-Object Text.UTF8Encoding $false))
        Log ("vmx: " + ((Select-String -Path $Vmx -Pattern '^(memsize|numvcpus)').Line -join ' / '))
    }
}

# 3) data disk + power on + IP
if (Step 3 "attach ${DiskGB}GB data disk, power on") {
    if (-not (Test-Path "$VmDir\wp_data.vmdk")) {
        & $vdm -c -s "${DiskGB}GB" -a lsilogic -t 0 "$VmDir\wp_data.vmdk" | Out-Null; if ($LASTEXITCODE) { Fail 'vdiskmanager' }; Log 'wp_data.vmdk created'
    }
    if (-not (Select-String -Path $Vmx -Pattern '^scsi0:1\.' -Quiet)) {
        if (VmRunning) { Fail 'VM is running; stop it before attaching the disk' }
        Add-Content -Path $Vmx -Encoding ASCII -Value 'scsi0:1.present = "TRUE"', 'scsi0:1.fileName = "wp_data.vmdk"', 'scsi0:1.deviceType = "scsi-hardDisk"'
        Log 'disk attached in vmx'
    }
    if (-not (VmRunning)) { & $vmrun -T ws start $Vmx gui; if ($LASTEXITCODE) { Fail 'vmrun start' }; Log 'powered on' }
    for ($i = 0; $i -lt 90; $i++) { if ((& $vmrun -T ws checkToolsState $Vmx) -match 'running') { break }; Start-Sleep 5 }
    $ip = (& $vmrun -T ws getGuestIPAddress $Vmx -wait).Trim()
    if ($ip -notmatch '^\d+\.\d+\.\d+\.\d+$') { Fail "no guest IP ($ip)" }
    Set-Content -Path $IpFile -Value $ip -Encoding ASCII; Log "guest IP $ip"
}

# 4) ssh key
if (Step 4 'install ssh key') {
    if (-not (Test-Path $Key)) {
        cmd /c "ssh-keygen -q -t rsa -b 2048 -m PEM -N `"`" -C waterpulse-host-to-vm -f `"$Key`""
        icacls $Key /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
        Log 'key created'
    }
    $sh = "#!/bin/bash`nmkdir -p ~/.ssh; chmod 700 ~/.ssh; touch ~/.ssh/authorized_keys; grep -qF waterpulse-host-to-vm ~/.ssh/authorized_keys || cat /tmp/wp_vm_rsa.pub >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys`n"
    [IO.File]::WriteAllText("$Root\keys\install_key.sh", $sh, (New-Object Text.UTF8Encoding $false))
    $g = '-T', 'ws', '-gu', 'training', '-gp', 'training'
    & $vmrun @g CopyFileFromHostToGuest $Vmx "$Key.pub" /tmp/wp_vm_rsa.pub
    & $vmrun @g CopyFileFromHostToGuest $Vmx "$Root\keys\install_key.sh" /tmp/install_key.sh
    & $vmrun @g runProgramInGuest $Vmx /bin/bash /tmp/install_key.sh; if ($LASTEXITCODE) { Fail 'key install in guest' }
    for ($i = 0; $i -lt 24; $i++) { $h = Guest 'hostname' 2>$null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 5 }
    if ($LASTEXITCODE) { Fail 'password-less ssh' }
    Log "ssh ok ($h)"
}

# 5) code + data
if (Step 5 "code/vm @ $Commit + data bundle") {
    $cz = "$Root\repo\waterpulse-$Commit.zip"
    $url = if ($Commit -eq 'main') { 'https://github.com/keemlogan/waterpulse/archive/refs/heads/main.zip' } else { "https://github.com/keemlogan/waterpulse/archive/$Commit.zip" }
    Remove-Item $cz -ErrorAction SilentlyContinue; Download $url $cz
    $cd = "$Root\repo\code_$Commit"; Remove-Item $cd -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $cd | Out-Null
    tar.exe -xf $cz -C $cd; $src = (Get-ChildItem $cd -Directory | Select-Object -First 1).FullName
    if (-not (Test-Path "$src\code\vm\guest\00_vm_bootstrap.sh")) { Fail 'code/vm missing in zip' }
    $tar = "$Root\data\wp_sample_v1.tar"
    if (-not ((Test-Path $tar) -and (Sha $tar) -eq $DataSha)) { Download $DataUrl $tar }
    if ((Sha $tar) -ne $DataSha) { Fail 'data bundle SHA256 mismatch' }
    Log 'code + data downloaded, SHA256 ok'
    Guest 'mkdir -p ~/waterpulse/logs; rm -rf ~/waterpulse/vm' | Out-Null
    ToGuest "$src\code\vm" 'waterpulse/' -Recurse
    ToGuest $tar 'waterpulse/'
    Guest 'find ~/waterpulse/vm -type f -exec sed -i s/\\r$// {} +; ls ~/waterpulse ~/waterpulse/vm' | ForEach-Object { Log "  $_" }
}

# 6) VM-side pipeline
if (Step 6 'VM bootstrap + step1 + step2') {
    foreach ($s in @('guest/00_vm_bootstrap.sh', 'guest/run_step1_raw.sh ~/waterpulse/wp_sample_v1.tar', 'guest/run_step2_clean_compare_spark.sh')) {
        $name = ($s -split '[/ ]')[1]; Log "run $name"
        $o = SshOpts; & ssh.exe -n @o (Target) "bash ~/waterpulse/vm/$s" *>&1 | Out-File -Encoding utf8 "$Root\logs\bootstrap_$name.txt"
        if ($LASTEXITCODE) { Fail "$name exit=$LASTEXITCODE (see logs\bootstrap_$name.txt)" }
        Log "$name ok"
    }
}

Log ("bootstrap done in {0:N1} min" -f ((Get-Date) - $t0).TotalMinutes)
