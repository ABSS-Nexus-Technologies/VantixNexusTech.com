# Nexora Nexus — Multi-Page Website

A clean, modern, Apple-inspired multi-page website for **Nexora Nexus**, built exclusively with semantic HTML5, modern CSS3, and lightweight vanilla JavaScript. Zero frameworks, zero build steps, and zero dependencies.

---

## 1. Multi-Page Architecture

The website is structured into 7 distinct pages, sharing a unified light-themed design system, typography scale, header, and footer:

1. [**`index.html`**](index.html) — **Home**: Hero introduction, capabilities trust strip, services overview, approach timeline, selected concept preview, about summary, and conversion CTA.
2. [**`services.html`**](services.html) — **Services**: In-depth breakdown of all 6 service categories (*Web Development, Mobile App Development, UI/UX Design, AI & Automation, Cloud & DevOps, Digital Transformation*), key deliverables, and technical standards.
3. [**`about.html`**](about.html) — **About Us**: Company profile, founding philosophy, operating principles, core values, and flexible engagement models.
4. [**`work.html`**](work.html) — **Portfolio / Our Work**: Showcase of 3 illustrative design concepts (*Northstar Studio, Flowline Ops, Aura Mobile*) with clear concept disclaimers and engineering benchmarks.
5. [**`contact.html`**](contact.html) — **Contact Us**: Accessible project inquiry form, direct communication channels, one-click email copy helper, and engagement FAQ.
6. [**`privacy.html`**](privacy.html) — **Privacy Policy**: Full privacy policy explaining client correspondence and data rights.
7. [**`terms.html`**](terms.html) — **Terms of Service**: Comprehensive terms covering website use, concept disclaimers, and intellectual property.

---

## 2. Design System & Refined Typography

### Color Palette (Bright Light Theme)
- **Primary Background**: Pure White (`#ffffff`) and soft off-white (`#f8f9fa`).
- **Primary Text**: Dark slate/navy (`#0f172a`), providing high contrast (WCAG AAA/AA) without harshness.
- **Secondary Text**: Slate (`#475569` and `#64748b`).
- **Brand Accent**: Refined royal blue (`#1d4ed8`), with hover states (`#1e40af`) and light tints (`#eff6ff`).
- **Borders & Dividers**: Soft light grey (`#e2e8f0`).
- **Cards**: Pure white (`#ffffff`) with subtle 1px border and gentle elevation shadows.
- **Dark Theme Removed**: No full-screen black sections, dark cards, or high-contrast dark theme elements.

### Refined Typography Scale
- **Body Text**: 15–17px (`16px` base, `14.5px` secondary, `1.65` line height).
- **Small Labels & Captions**: 12–14px (`13px` caption, `11.5px` tag pills).
- **Hero Headings**: `clamp(34px, 4.2vw, 50px)` on desktop, `clamp(30px, 7vw, 40px)` on mobile.
- **Section Headings**: `clamp(26px, 3vw, 36px)` on desktop, `clamp(24px, 5.5vw, 30px)` on mobile.
- **Card Headings**: 18–22px (`19px` standard).
- **Navigation Links**: 14.5px with active indicator.
- **Buttons**: 14px with tactile hover & active press states.

---

## 3. Scripts & Functionality (`script.js`)

- **Sticky Header**: Applies elevated `.scrolled` state with backdrop blur on page scroll.
- **Mobile Menu Drawer**: Accessible toggle with animated icon, `aria-expanded` attributes, body scroll lock (`.nav-locked`), and `Escape` key support across all 7 pages.
- **Active Navigation Highlighting**: Visual indicators on the current page's link in desktop and mobile navigation.
- **Scroll Reveals**: Lightweight `IntersectionObserver` animations respecting `prefers-reduced-motion`.
- **One-Click Email Copy**: `#copy-email-btn` copies `hello@nexoranexus.com` to clipboard with visual feedback (`Copied to clipboard! ✓`).
- **Contact Form Validation**: Native validation with formatted email draft generation via `mailto:`.
- **Dynamic Copyright Year**: Updates `#year` automatically.

---

## 4. Running the Website Locally

1. **Direct Browser**: Double-click `index.html` or open any `.html` file in your preferred browser.
2. **Local Python Server**:
   ```bash
   python3 -m http.server 5502
   ```
   Open `http://localhost:5502` in your browser.
3. **VS Code Live Server**: Open the workspace folder in VS Code and click "Go Live" (configured for port 5502 in `.vscode/settings.json`).
