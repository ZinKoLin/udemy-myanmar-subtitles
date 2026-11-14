#!/bin/sh
set -eu
cd "$(dirname "$0")"
if test -e .env; then echo '.env already exists. Edit it directly; setup will not overwrite saved credentials.'; exit 1; fi
printf 'Gemini Pro account email: '
read -r pro_email
case "$pro_email" in *[!a-zA-Z0-9.@_+-]*|*@*@*|'') echo 'Enter a valid email address.'; exit 1 ;; esac
case "$pro_email" in *@*.*) ;; *) echo 'Enter a valid email address.'; exit 1 ;; esac
umask 077
{
  printf 'GEMINI_ACCOUNT_EMAIL=%s\nGEMINI_ACCOUNT_INDEX=0\n' "$pro_email"
  printf 'RUNNER_TOKEN=%s\n' "$(openssl rand -hex 32)"
  printf 'WEBHOOK_TOKEN=%s\n' "$(openssl rand -hex 32)"
  printf 'VNC_PASSWORD=%s\n' "$(openssl rand -hex 4)"
  printf 'N8N_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
} > .env
echo 'Created private .env. Run: docker compose up -d --build'
echo 'Then follow README.md to sign in and configure the n8n workflow credentials.'
