# Nexora Nexus — Production Technical SEO & Deployment Guide

This guide details the final configuration steps required upon deploying Nexora Nexus to a live production domain.

---

## 1. Domain Confirmation & Canonical URLs

As required by search engines, canonical tags must only point to the confirmed production protocol and domain name (never `localhost` or staging URLs).

### Instructions:
Once your production domain is finalized (for example: `https://nexoranexus.com`), execute a single find-and-replace across all 23 HTML files:

**Find:**
```html
<!-- <link rel="canonical" href="https://[YOUR_PRODUCTION_DOMAIN]/FILENAME.html"> -->
```

**Replace with (Uncommented):**
```html
<link rel="canonical" href="https://nexoranexus.com/FILENAME.html">
```

*(On the homepage `index.html`, point the canonical tag to root: `https://nexoranexus.com/`)*

---

## 2. Production Sitemap (`sitemap.xml`)

The `sitemap.xml` file is generated and contains all 23 public HTML pages with appropriate indexing priorities:
- `index.html` (Priority: 1.0)
- `services.html` (Priority: 0.9)
- 15 Dedicated Service Detail Pages (Priority: 0.85)
- `solutions.html` (Priority: 0.85)
- `work.html` (Priority: 0.8)
- `about.html` (Priority: 0.7)
- `contact.html` (Priority: 0.8)
- `privacy.html` & `terms.html` (Priority: 0.3)

### Instructions:
In `sitemap.xml`, replace all instances of:
```
https://[YOUR_PRODUCTION_DOMAIN]/
```
with your confirmed live domain (e.g., `https://nexoranexus.com/`).

---

## 3. Search Engine Crawling Instructions (`robots.txt`)

The `robots.txt` file is pre-configured to:
1. Allow full crawling of all public content and pages.
2. Explicitly allow search crawlers (Googlebot, Bingbot) to access `style.css` and `script.js` so they can accurately render pages and compute Core Web Vitals (LCP, CLS, INP).
3. Reference the production `sitemap.xml`.

### Instructions:
In `robots.txt`, update the final line:
```
Sitemap: https://[YOUR_PRODUCTION_DOMAIN]/sitemap.xml
```
to your live sitemap location (e.g., `Sitemap: https://nexoranexus.com/sitemap.xml`).

---

## 4. Structured Data (JSON-LD)

All 23 pages now include schema.org compliant JSON-LD structured data:
- **`index.html`**: `Organization` schema with official services and verified contact (`hello@nexoranexus.com`), plus `WebSite` schema.
- **15 Service Detail Pages**: Dedicated `Service` schema specifying technical capabilities, provider, and area served, alongside a 3-tier `BreadcrumbList` (Home → Services → [Service Name]).
- **`services.html`**: `BreadcrumbList` plus `ItemList` enumerating all 15 services.
- **`solutions.html`, `work.html`, `about.html`, `contact.html`, `privacy.html`, `terms.html`**: Complete hierarchical `BreadcrumbList` schemas.

---

## 5. Performance & Rendering Guardrails

1. **3D Canvas & Animation Lifecycle**:
   - `IntersectionObserver` automatically halts `requestAnimationFrame` loops when canvases are scrolled out of view.
   - `document.visibilitychange` automatically freezes all canvas computations when the browser tab is switched or minimized, eliminating background CPU/GPU drain.
   - Window resize recalculations are debounced using `requestAnimationFrame`.
2. **Cumulative Layout Shift (CLS)**:
   - All 655+ SVG graphics have explicit `width` and `height` dimensions.
   - `style.css` declares `content-visibility: auto` and `height: auto` on image elements.
3. **Reduced Motion**:
   - Complete `prefers-reduced-motion: reduce` CSS rules disable animations and transforms for users who prefer minimal motion.
