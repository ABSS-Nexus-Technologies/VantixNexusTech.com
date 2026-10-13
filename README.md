# Nexora Nexus — Production Website & Launch Guide

A state-of-the-art, Apple-inspired multi-page website for **Nexora Nexus**, engineered with semantic HTML5, vanilla CSS3, and lightweight JavaScript. Zero dependencies, zero build steps, and 100% static hosting ready.

---

## 1. Project Architecture

The website contains **24 standalone HTML pages**, sharing a unified high-contrast light theme, responsive header with hover/click mega-menu, interactive 3D background experiences, and mobile navigation drawer:

### Core Pages
- [`index.html`](index.html) — **Homepage**: Hero canvas with 3D floating glass orbs, capabilities trust strip, service architecture overview, development approach, selected illustrative concepts, and conversion CTAs.
- [`services.html`](services.html) — **Services Hub**: Comprehensive overview of all 15 disciplines, technical standards, and service engagement roadmap.
- [`solutions.html`](solutions.html) — **Solutions**: Enterprise transformation pillars, industry capabilities, and technical delivery frameworks.
- [`work.html`](work.html) — **Selected Work**: Interactive showcase of 3 architectural concepts (*Northstar Studio, Flowline Ops, Aura Mobile*) with clear concept disclaimers and engineering metrics.
- [`about.html`](about.html) — **About Us**: Company profile, founding philosophy, operating principles, core values, and team collaboration models.
- [`contact.html`](contact.html) — **Contact & Inquiries**: Accessible project inquiry form, budget & timeline selectors, service preselection handler, spam honeypot trap, and direct communication channels.
- [`privacy.html`](privacy.html) — **Privacy Policy**: Transparent data protection and correspondence guidelines.
- [`terms.html`](terms.html) — **Terms of Service**: Terms of use, intellectual property rights, and concept disclaimers.
- [`404.html`](404.html) — **Error Page**: Branded, user-friendly 404 error experience with quick links to all 15 services and return-to-home actions.

### 15 Official Service Detail Pages
Each service features dedicated architecture deep-dives, deliverable matrices, technology stacks, service-specific FAQs, and query-parameter-preserving CTAs (`contact.html?service=[slug]`):
1. [`website-development.html`](website-development.html) — Website Development
2. [`software-development.html`](software-development.html) — Software Development
3. [`mobile-app-development.html`](mobile-app-development.html) — Mobile App Development
4. [`ai-machine-learning.html`](ai-machine-learning.html) — Artificial Intelligence (AI) & Machine Learning
5. [`digital-marketing-seo.html`](digital-marketing-seo.html) — Digital Marketing & SEO
6. [`cloud-computing.html`](cloud-computing.html) — Cloud Computing
7. [`cybersecurity.html`](cybersecurity.html) — Cybersecurity
8. [`ecommerce-development.html`](ecommerce-development.html) — E-commerce Development
9. [`ui-ux-design.html`](ui-ux-design.html) — UI/UX Design
10. [`data-analytics-bi.html`](data-analytics-bi.html) — Data Analytics & Business Intelligence
11. [`devops-automation.html`](devops-automation.html) — DevOps & Automation
12. [`saas-development.html`](saas-development.html) — SaaS Product Development
13. [`api-development-integration.html`](api-development-integration.html) — API Development & Integration
14. [`it-consulting-digital-transformation.html`](it-consulting-digital-transformation.html) — IT Consulting & Digital Transformation
15. [`software-testing-qa.html`](software-testing-qa.html) — Software Testing & Quality Assurance

---

## 2. How to Preview the Website Locally

You can preview the website locally without installing any build tools:

### Option A: Python Built-in Web Server (Recommended)
Open Terminal in the project directory:
```bash
python3 -m http.server 5502
```
Then visit: [`http://localhost:5502`](http://localhost:5502)

### Option B: Node / npx serve
```bash
npx serve .
```

### Option C: VS Code Live Server
Open the folder in VS Code, right-click `index.html`, and select **"Open with Live Server"**.

---

## 3. How to Deploy the Website

Because this is a pure static website with relative asset paths, it can be hosted on any static hosting platform for free.

### Option 1: GitHub Pages (Recommended — 1-Click Setup)
Your repository is already pushed to GitHub:
`https://github.com/ABSS-Nexus-Technologies/VantixNexusTech.com`

To make it live instantly:
1. Open your repository on GitHub: [github.com/ABSS-Nexus-Technologies/VantixNexusTech.com](https://github.com/ABSS-Nexus-Technologies/VantixNexusTech.com)
2. Go to **Settings** &rarr; **Pages** (in the left sidebar).
3. Under **Build and deployment**:
   - **Source**: Select `Deploy from a branch`.
   - **Branch**: Select `main`.
   - **Folder**: Select `/ (root)`.
4. Click **Save**.
5. Within 1–2 minutes, GitHub Pages will deploy your site at:
   `https://abss-nexus-technologies.github.io/VantixNexusTech.com/`

*(Note: `.nojekyll` is already included in the root directory to guarantee all files and assets serve cleanly).*

---

### Option 2: Netlify (Free Tier, Automatic HTTPS & Global CDN)
1. Sign up or log in at [netlify.com](https://www.netlify.com).
2. Click **"Add new site"** &rarr; **"Import an existing project"**.
3. Choose **GitHub** and authorize access to `ABSS-Nexus-Technologies/VantixNexusTech.com`.
4. Leave build command empty; set publish directory to `.` (root).
5. Click **"Deploy site"**.
6. Netlify assigns an instant live URL (`https://your-site-name.netlify.app`).

*(Note: `_headers` is already included for security headers and optimal caching).*

---

### Option 3: Vercel (Free Tier, Edge Network)
1. Sign up or log in at [vercel.com](https://vercel.com).
2. Click **"Add New..."** &rarr; **"Project"**.
3. Select your GitHub repository `ABSS-Nexus-Technologies/VantixNexusTech.com`.
4. Framework Preset: **Other**; Root Directory: `./`.
5. Click **"Deploy"**.

*(Note: `vercel.json` is already configured for clean URLs and security headers).*

---

## 4. How to Connect a Custom Domain

Once you purchase your domain (e.g., from Namecheap, GoDaddy, Google Domains, Cloudflare):

### 1. In Your Hosting Provider:
- **GitHub Pages**: Go to **Settings** &rarr; **Pages** &rarr; **Custom domain** &rarr; enter your domain (e.g., `vantixnexustech.com` or `nexoranexus.com`) &rarr; click **Save**. Check the box for **"Enforce HTTPS"**.
- **Netlify**: Go to **Site settings** &rarr; **Domain management** &rarr; **Add a custom domain**.
- **Vercel**: Go to **Project Settings** &rarr; **Domains** &rarr; **Add**.

### 2. In Your Domain Registrar (DNS Settings):
Your hosting dashboard will display the exact DNS records to enter. Typically:

- **Apex Domain (`@` / `yourdomain.com`)**:
  Add **A** records pointing to the provider's IP addresses (for GitHub Pages: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`).
- **Subdomain (`www`)**:
  Add a **CNAME** record pointing to your provider's target (for GitHub Pages: `<username>.github.io.`; for Netlify: `<site-name>.netlify.app.`).

> **Important:** Always copy the exact DNS records shown in your hosting provider's dashboard. Do not guess DNS values.

### 3. HTTPS / SSL:
HTTPS is provided automatically and free of charge via Let's Encrypt on GitHub Pages, Netlify, and Vercel. Once DNS propagation finishes (typically 15–60 minutes), the SSL certificate is automatically generated.

---

## 5. Pre-Launch Configuration Checklist

Before announcing your website publicly, replace the designated configuration placeholders with your actual business values:

### 1. Production Domain (`robots.txt` & `sitemap.xml`)
- In [`robots.txt`](robots.txt), replace `[YOUR_PRODUCTION_DOMAIN]` with your live domain:
  ```text
  Sitemap: https://yourdomain.com/sitemap.xml
  ```
- In [`sitemap.xml`](sitemap.xml), find and replace all instances of:
  `https://[YOUR_PRODUCTION_DOMAIN]/` &rarr; `https://yourdomain.com/`
- *(Optional)* In HTML `<head>` tags, uncomment the `<link rel="canonical">` tag pointing to your live domain.

### 2. Contact Form Delivery (`script.js`)
Located at lines 375–385 in [`script.js`](script.js):
```javascript
const FORM_BACKEND_CONFIG = {
  // Enter your public POST endpoint (e.g. Formspree, Basin, Getform, or a custom API route)
  endpoint: '', // Example: 'https://formspree.io/f/your_form_id'
  targetEmail: 'hello@nexoranexus.com'
};
```
- If left empty, the contact form safely informs the visitor that direct server delivery is awaiting configuration and provides a 1-click email client draft (`mailto:`) and copy button.
- Never commit private SMTP passwords or secret keys in client JavaScript.

### 3. WhatsApp Business Line (`script.js`)
Located at lines 395–402 in [`script.js`](script.js):
```javascript
const WHATSAPP_CONFIG = {
  // Enter your international phone number in E.164 format without '+' or spaces
  phoneNumber: '', // Example: '919876543210' for India
  defaultMessage: 'Hello Nexora Nexus team, I would like to inquire about your engineering services for an upcoming project.'
};
```
- If left empty, clicking the floating WhatsApp button displays an accessible modal informing visitors that the business line is awaiting setup and directing them to `hello@nexoranexus.com`.

---

## 6. How to Update the Website in the Future

Whenever you make improvements or content updates:

1. Test your changes locally:
   ```bash
   python3 -m http.server 5502
   ```
2. Commit and push your changes to GitHub:
   ```bash
   git add .
   git commit -m "Describe your update (e.g. update service descriptions)"
   git push origin main
   ```
3. Your hosting provider (GitHub Pages, Netlify, or Vercel) will automatically detect the push and update your live website within 30–60 seconds!

---

## 7. Technology Summary
- **Markup**: Pure HTML5 (W3C valid, semantic, accessible ARIA attributes).
- **Styling**: Vanilla CSS3 (`style.css`), CSS Custom Properties design system, responsive clamp typography, reduced-motion media queries.
- **Logic**: Vanilla JavaScript ES6+ (`script.js`), IntersectionObserver scroll reveals, Canvas 3D visualizers, form validation, and service preselection.
- **Dependencies**: 0 external npm packages, 0 frameworks, 0 compilers. Fast page loads and minimal attack surface.
