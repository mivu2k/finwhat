# Deploying ExpenseChat to a Proxmox LXC

End result: `https://YOUR_DOMAIN/` serves the web app, `https://YOUR_DOMAIN/api` the API, and the phone app connects to that address.

Commands starting with `pve#` run on the Proxmox host; `ct#` run inside the container as root.

## 1. Create the container

In Proxmox, download a template (**local → CT Templates → Templates → debian-12-standard**), then **Create CT**:

| Setting | Value |
|---|---|
| Unprivileged | Yes |
| Disk | 20 GB or more (receipts are stored here) |
| CPU | 2 cores |
| Memory | 2048 MB, swap 1024 MB (the web build needs it) |
| Network | DHCP to start; a DHCP reservation or static IP is better |

Start it, open its console, and update:

```bash
ct# apt update && apt full-upgrade -y
ct# apt install -y curl git nginx sqlite3 sudo ca-certificates
ct# timedatectl set-timezone Asia/Karachi    # your timezone
```

## 2. Install Node.js 24

The server runs TypeScript directly and needs Node 24.

```bash
ct# curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
ct# apt install -y nodejs
ct# node -v     # v24.x
```

## 3. Get the code from GitHub

The repository is private, so give the container its own read-only key:

```bash
ct# useradd --system --create-home --home-dir /home/expensechat --shell /bin/bash expensechat
ct# sudo -u expensechat ssh-keygen -t ed25519 -N "" -f /home/expensechat/.ssh/id_ed25519
ct# cat /home/expensechat/.ssh/id_ed25519.pub
```

On GitHub: repository → **Settings → Deploy keys → Add deploy key**, paste it, leave write access off. Then:

```bash
ct# mkdir -p /opt/expensechat /var/lib/expensechat/uploads
ct# chown -R expensechat: /opt/expensechat /var/lib/expensechat
ct# sudo -u expensechat git clone git@github.com:mivu2k/finwhat.git /opt/expensechat
ct# cd /opt/expensechat
ct# sudo -u expensechat npm ci
```

Accept the GitHub host fingerprint if asked.

## 4. Choose a database

**SQLite** is one file with nothing to install, and suits a small team. Skip to step 5 and use the SQLite line.

**MySQL** is better for many people working at once:

```bash
ct# apt install -y mariadb-server    # or MySQL 8 from Oracle's repository; see the note below
ct# DBPW=$(openssl rand -hex 16); echo "Database password: $DBPW"
ct# mysql -e "CREATE DATABASE expensechat CHARACTER SET utf8mb4; CREATE USER 'expensechat'@'127.0.0.1' IDENTIFIED BY '$DBPW'; GRANT ALL ON expensechat.* TO 'expensechat'@'127.0.0.1';"
```

> The project is developed and tested on MySQL 8. MariaDB is not the same product and is untested here. If you want MySQL mode to match testing exactly, install MySQL 8 from https://dev.mysql.com/downloads/repo/apt/, or use SQLite, which is also fully tested.

## 5. Configure

```bash
ct# cd /opt/expensechat
ct# openssl rand -hex 32     # copy this for JWT_SECRET
ct# nano .env
```

```ini
# pick one
DATABASE_URL=sqlite:/var/lib/expensechat/expensechat.db
# DATABASE_URL=mysql://expensechat:THE_PASSWORD@127.0.0.1:3306/expensechat

JWT_SECRET=PASTE_THE_RANDOM_VALUE
PORT=4000
UPLOAD_DIR=/var/lib/expensechat/uploads

# your real address, with https once step 9 is done
PUBLIC_API_URL=https://YOUR_DOMAIN/api
EXPO_PUBLIC_API_URL=https://YOUR_DOMAIN/api
CORS_ORIGIN=https://YOUR_DOMAIN

# password-reset emails; without this, codes only appear in the server log
# SMTP_URL=smtps://user:pass@smtp.example.com:465
# MAIL_FROM=ExpenseChat <no-reply@YOUR_DOMAIN>

# optional; AI can also be set per workspace in the app (workspace menu > AI settings)
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
```

```bash
ct# chown expensechat: .env && chmod 600 .env
```

Never change `JWT_SECRET` later: it would sign everyone out, break AI keys saved in the app, and invalidate file links.

## 6. Build the web app

```bash
ct# sudo -u expensechat bash -c 'set -a; . ./.env; set +a; npx expo export --platform web --output-dir dist'
```

`EXPO_PUBLIC_API_URL` is built into the web app, so rebuild if the address changes.

## 7. Start the API

```bash
ct# cp deploy/expensechat-api.service /etc/systemd/system/
ct# systemctl daemon-reload
ct# systemctl enable --now expensechat-api
ct# systemctl status expensechat-api --no-pager
ct# curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4000/me    # 401 means it works
```

Tables are created on first start. Logs: `journalctl -u expensechat-api -f`.

Do not run `npm run seed` on a real system: it creates demo users with a known password.

## 8. Set up nginx

```bash
ct# cp deploy/nginx.conf /etc/nginx/sites-available/expensechat
ct# sed -i 's/YOUR_DOMAIN_OR_IP/YOUR_DOMAIN/' /etc/nginx/sites-available/expensechat
ct# ln -sf /etc/nginx/sites-available/expensechat /etc/nginx/sites-enabled/expensechat
ct# rm -f /etc/nginx/sites-enabled/default
ct# chmod o+x /opt/expensechat
ct# nginx -t && systemctl reload nginx
```

## 9. HTTPS

Passwords and receipts cross this connection, so use HTTPS for anything beyond a private test. Choose one:

**A. Cloudflare Tunnel** (no router changes, works behind CGNAT). In Cloudflare Zero Trust create a tunnel, run the install command it gives you inside the container, and point your hostname at `http://localhost:80`.

**B. Port forwarding and Let's Encrypt.** Point the domain's DNS at your public IP, forward ports 80 and 443 to the container, then:

```bash
ct# apt install -y certbot python3-certbot-nginx
ct# certbot --nginx -d YOUR_DOMAIN
```

**C. Local network only, for testing.** Use `http://CONTAINER_IP` everywhere in step 5 and rebuild (step 6). The Android test APK allows this; iPhones and real use do not.

Open `https://YOUR_DOMAIN/`, create your account, and create your workspace. The person who creates a workspace is its admin.

## 10. Phone app

Either tap **Server: … Change** on the login screen, enter `https://YOUR_DOMAIN/api`, and **Test & save**; or build an APK with that address built in, on the machine with the Android toolchain:

```bash
scripts/build-apk.sh https://YOUR_DOMAIN/api
```

## 11. Backups

```bash
ct# crontab -e
```
```cron
30 2 * * * /opt/expensechat/deploy/backup.sh
```

For MySQL, the script uses `mysqldump`, which as root connects through the local socket. Also enable a scheduled backup of the container under **Proxmox → Datacenter → Backup**, and keep a copy off this machine. Try a restore once.

To restore: stop the API, restore the database (`gunzip -c db-DATE.sql.gz | mysql expensechat`, or copy the SQLite file back and `chown expensechat:` it), extract the uploads tar into `UPLOAD_DIR`, and start the API. Keep the same `JWT_SECRET`.

## 12. Updating

On your computer: `git push`. Then on the server:

```bash
ct# /opt/expensechat/deploy/update.sh
```

Database changes apply automatically when the API starts. Back up first when an update is large.

## Moving your existing data (optional)

From the current MySQL on your PC:

```bash
mysqldump --single-transaction expensechat > expensechat.sql
tar -czf uploads.tar.gz -C server/uploads .
```

Copy both to the container, use MySQL in step 4, and before step 7:

```bash
ct# mysql expensechat < expensechat.sql
ct# tar -xzf uploads.tar.gz -C /var/lib/expensechat/uploads && chown -R expensechat: /var/lib/expensechat
```

Use the same `JWT_SECRET` if you saved AI keys in the app. This also brings the demo accounts (password `password123`) and test records: delete or change those before going public.

## Local AI (optional)

Install Ollama in this container or on another machine, then set the address in the app's AI settings. `localhost` means this container. For a GPU on another machine use its address, and set `OLLAMA_HOST=0.0.0.0` there.

## Troubleshooting

| Symptom | Check |
|---|---|
| Web page says it can't reach the server | `EXPO_PUBLIC_API_URL` at build time; `systemctl status expensechat-api` |
| 502 from nginx | API is down: `journalctl -u expensechat-api -n 50` |
| Images or audio don't load | `PUBLIC_API_URL` must be the public address including `/api` |
| Uploads fail with 413 | `client_max_body_size` in nginx |
| `JWT_SECRET must be set` | `.env` missing, or under 32 characters |
| Permission errors on files | `chown -R expensechat: /var/lib/expensechat` |
| Build killed with no error | Out of memory: add RAM or swap to the container |
| Push notifications don't arrive | They also need an Expo project and Firebase credentials |

## Before real users

- [ ] HTTPS is on
- [ ] No demo accounts (`password123`) on the server
- [ ] `SMTP_URL` set, so people can reset passwords
- [ ] Backups run, and a restore has been tried
- [ ] Ports 3306 and 4000 are not reachable from the internet
