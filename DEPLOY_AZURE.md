# Deploy DIU CGPA Calculator (Azure for Students)

- **Backend:** Azure VM (Docker + Camoufox) behind a Cloudflare Tunnel for HTTPS
- **Database:** Supabase Cloud
- **Frontend:** Vercel (Next.js)

> **Never commit real keys.** Every secret below goes into the VM's `.env` file or the Vercel
> dashboard only. `.env` is git-ignored.

---

## Part 1: Create the Azure VM

1. In the [Azure Portal](https://portal.azure.com) → **Virtual machines** → **Create**.
2. **Image:** Ubuntu Server 24.04 LTS.
3. **Size:** one of the Azure for Students free sizes (750 hrs/month each, 1 GiB RAM):
   - `B2ats_v2` (2 vCPU, AMD) - preferred if your subscription has quota
   - `B1s` (1 vCPU) - always available
4. **Inbound ports:** allow **SSH (22) only**. The backend is reached through the Cloudflare
   Tunnel, so port 8000 must **not** be opened to the internet.

### Add swap (strongly recommended on 1 GiB)
```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## Part 2: Run the Backend

The repository is **private**, so the VM downloads it with a read-only **deploy key**:
```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/github_deploy -C "diu-backend deploy key"
printf "Host github.com\n  IdentityFile ~/.ssh/github_deploy\n  IdentitiesOnly yes\n" >> ~/.ssh/config
cat ~/.ssh/github_deploy.pub   # add in GitHub: repo → Settings → Deploy keys → Add (leave "write" unticked)
```

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
git clone git@github.com:<you>/diu-cgpa-calculator.git && cd diu-cgpa-calculator
nano .env   # fill in the values below
sudo docker compose up -d --build
```

`.env` (placeholders - use your own values):
```bash
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_KEY=<supabase service_role key>          # Supabase → Settings → API
PASSWORD_PEPPER=<random 32+ chars>                # openssl rand -hex 32  (never change it later)
ADMIN_EMAILS=<your admin google email>
GOOGLE_CLIENT_ID=<oauth client id>.apps.googleusercontent.com
ALLOWED_ORIGINS=https://<your-app>.vercel.app,http://localhost:3000

# Capacity (optional - defaults are sized from the VM's RAM/CPU)
# MAX_CONCURRENT_SCRAPES=2
# WARM_BROWSERS=1
# LAUNCH_CONCURRENCY=1
```

The container publishes port 8000 on **127.0.0.1 only** (see `docker-compose.yml`), so it is
reachable by the tunnel on the same VM but not from the internet.

---

## Part 3: HTTPS via a named Cloudflare Tunnel (permanent address)

The domain's DNS is managed by Cloudflare (nameservers changed at the registrar; the Vercel
records `@ A 76.76.21.21` and `www CNAME cname.vercel-dns.com` are **DNS only**, grey cloud).

1. Install cloudflared on the VM:
   ```bash
   # x86 VMs (B1s, B2ats_v2). For the Arm size (B2pts_v2) use cloudflared-linux-arm64.deb
   wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
   sudo dpkg -i cloudflared-linux-amd64.deb
   ```
2. Cloudflare dashboard → **Tunnels** → **Create a tunnel** → Cloudflared → name `diu-backend`.
   Copy only the `eyJ...` token from the install command into `~/.cloudflared-token`
   (one line), then `chmod 600 ~/.cloudflared-token`. Never commit or share the token.
3. Run it as a service that starts at boot:
   ```bash
   sudo tee /etc/systemd/system/cloudflared-named.service > /dev/null <<'EOF'
   [Unit]
   Description=Cloudflare named tunnel (api.resultscraper.app)
   After=network-online.target
   Wants=network-online.target

   [Service]
   User=azureuser
   ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token-file /home/azureuser/.cloudflared-token
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   EOF
   sudo systemctl daemon-reload && sudo systemctl enable --now cloudflared-named
   ```
4. In the tunnel's **Routes**, add a published application: `api` . `resultscraper.app` →
   `http://127.0.0.1:8000` (not `localhost`: the backend listens on 127.0.0.1 only).

The backend is then always at `https://api.resultscraper.app`, including after reboots.

---

## Part 4: Deploy the Frontend on Vercel

1. Import the repository in [Vercel](https://vercel.com), **Root Directory** = `frontend`.
2. **Environment Variables** (Project → Settings → Environment Variables):
   - `NEXT_PUBLIC_API_URL` = `https://api.resultscraper.app`
   - `NEXT_PUBLIC_GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_ID` = your OAuth client ID
   - `GOOGLE_CLIENT_SECRET` = your OAuth client secret
   - `NEXTAUTH_URL` = your Vercel URL
   - `NEXTAUTH_SECRET` = output of `openssl rand -base64 32`
3. Deploy.

## Part 5: Google OAuth origins
In [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials), open
your OAuth client and add your Vercel URL under **Authorized JavaScript origins** and
`<vercel-url>/api/auth/callback/google` under **Authorized redirect URIs**.

---

## Security checklist
- [ ] Port 8000 closed in the Azure network security group (tunnel only)
- [ ] `ADMIN_EMAILS` and `GOOGLE_CLIENT_ID` set on the backend (admin is disabled without them)
- [ ] `PASSWORD_PEPPER` set and backed up somewhere safe
- [ ] `NEXTAUTH_SECRET` / `GOOGLE_CLIENT_SECRET` only in Vercel, never in git
- [ ] `ALLOWED_ORIGINS` lists exactly your frontend URLs
