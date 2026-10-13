#!/bin/bash
OUT=/tmp/wp_sshkey.txt; : > $OUT
{ mkdir -p ~/.ssh; chmod 700 ~/.ssh; touch ~/.ssh/authorized_keys; grep -qF 'waterpulse-host-to-vm' ~/.ssh/authorized_keys || cat /tmp/wp_vm_rsa.pub >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; ls -ld ~/.ssh; ls -l ~/.ssh/authorized_keys; restorecon -Rv ~/.ssh 2>&1; getenforce; } >> $OUT 2>&1
