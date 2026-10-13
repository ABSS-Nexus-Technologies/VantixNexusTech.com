# Nexora Nexus — Cloudflare Pages Deployment Guide

A step-by-step walkthrough for deploying the **Nexora Nexus** static website to **Cloudflare Pages** using your existing GitHub repository.

---

## 1. Project Verification Summary
- **Repository**: [`https://github.com/ABSS-Nexus-Technologies/VantixNexusTech.com`](https://github.com/ABSS-Nexus-Technologies/VantixNexusTech.com)
- **Production Branch**: `main`
- **Tech Stack**: Pure HTML5, CSS3, and vanilla JavaScript (no npm dependencies, zero build steps).
- **Total Pages**: 24 standalone HTML pages (all 15 service detail pages + core pages + 404 error page).
- **Asset Routing**: 100% relative paths (`href="services.html"`, `src="style.css"`). Fully compatible with Cloudflare's global edge network.

---

## 2. Step-by-Step Cloudflare Pages Deployment

### Step 1: Sign in to Cloudflare
1. Go to the Cloudflare dashboard: **[dash.cloudflare.com](https://dash.cloudflare.com/)**
2. Sign in with your Cloudflare account (or create a free account if you don't have one).

### Step 2: Open Workers & Pages
1. In the left-hand navigation sidebar, click on **Workers & Pages**.
2. Click the blue **Create** button.
3. Select the **Pages** tab (next to the Workers tab).
4. Click **Connect to Git**.

### Step 3: Connect Your GitHub Repository
1. Select your GitHub account (`ABSS-Nexus-Technologies`).
   *(If prompted, click "Install & Authorize Cloudflare Pages" on your GitHub account).*
2. Under **Select a repository**, choose:
   👉 **`VantixNexusTech.com`**
3. Click **Begin setup**.

### Step 4: Configure Build Settings
Configure the project with these exact settings:

| Setting | Value to Select / Enter | Note |
| :--- | :--- | :--- |
| **Project name** | `vantixnexustech-com` (or your preferred name) | Determines your temporary `*.pages.dev` subdomain. |
| **Production branch** | `main` | Cloudflare will automatically build whenever `main` updates. |
| **Framework preset** | **`None`** | Pure HTML/CSS/JS requires no framework. |
| **Build command** | *(Leave completely empty)* | Do not enter any build command. |
| **Build output directory** | `/` (or leave empty) | Cloudflare serves files directly from the root directory. |
| **Root directory** | `/` (or leave empty) | All HTML files reside in the root repository. |

> **IMPORTANT:** Do NOT select React, Next.js, or any other framework preset. Leave **Build command** empty.

### Step 5: Save and Deploy
1. Click **Save and Deploy**.
2. Cloudflare will clone your repository, verify the static assets, and deploy across its global edge network.
3. Within **15–30 seconds**, the deployment will show a green checkmark: **"Success! Your site is deployed."**
4. Click the generated URL (e.g., `https://vantixnexustech-com.pages.dev`) to preview your live website!

---

## 3. How to Connect a Custom Domain Later

When you purchase your official domain name (e.g., `vantixnexustech.com` or `nexoranexus.com`):

1. Go to **Workers & Pages** in your Cloudflare dashboard.
2. Click on your project (**`vantixnexustech-com`**).
3. Click on the **Custom domains** tab.
4. Click **Set up a custom domain**.
5. Enter your domain name (e.g. `yourdomain.com`).
6. Cloudflare will guide you through DNS verification:
   - **If your domain's DNS is already on Cloudflare**: Cloudflare automatically adds the DNS record with a single click.
   - **If your domain is with another registrar (GoDaddy, Namecheap, etc.)**: Cloudflare displays the exact `CNAME` record to add in your registrar's DNS dashboard.
7. **Free Automatic SSL/TLS**: Cloudflare automatically provisions and renews an edge SSL certificate. No manual certificate installation needed.

---

## 4. Pre-Launch Configuration Checklist

Before public launch, update these remaining placeholders:

1. **Production Domain in SEO Files**:
   - In [`robots.txt`](robots.txt), replace `[YOUR_PRODUCTION_DOMAIN]` with your live domain:
     ```text
     Sitemap: https://yourdomain.com/sitemap.xml
     ```
   - In [`sitemap.xml`](sitemap.xml), replace `https://[YOUR_PRODUCTION_DOMAIN]/` with your live domain.
2. **Form Backend Endpoint (`script.js`)**:
   - Line 379 in [`script.js`](script.js):
     ```javascript
     const FORM_BACKEND_CONFIG = {
       endpoint: '', // Enter your Formspree/Basin endpoint URL when ready
       targetEmail: 'hello@nexoranexus.com'
     };
     ```
3. **WhatsApp Business Phone (`script.js`)**:
   - Line 396 in [`script.js`](script.js):
     ```javascript
     const WHATSAPP_CONFIG = {
       phoneNumber: '', // Enter your E.164 phone number (e.g., '919876543210')
       defaultMessage: 'Hello Nexora Nexus team, I would like to inquire about your engineering services for an upcoming project.'
     };
     ```

---

## 5. Ongoing Updates Workflow
Whenever you make changes to your website:
```bash
git add .
git commit -m "Update service details"
git push origin main
```
Cloudflare Pages will automatically detect the push and deploy the updated version to your live URL within seconds.
