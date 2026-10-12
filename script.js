/**
 * Nexora Nexus — Navigation & Interactivity System
 * Apple-inspired Mega Menu, Hover/Click Interactions, Mobile Drawer Accordion,
 * Keyboard Accessibility, Scroll Reveals & Contact Form.
 */

// Enable progressive enhancement for modern motion system
document.documentElement.classList.add('js');

document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  /* --------------------------------------------------------------------------
     0. Lightweight Page Transitions & Navigation Handling
     -------------------------------------------------------------------------- */
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Intercept same-origin internal links for subtle exit transition without framework overhead
  if (!prefersReducedMotion) {
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[href]');
      if (!link) return;

      // Ignore modified clicks (new tab, cmd+click, ctrl+click)
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (link.target && link.target !== '_self') return;

      const href = link.getAttribute('href');
      if (!href) return;

      // Ignore anchor jumps on same page, javascript, mailto, tel
      if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
        return;
      }

      // Check if it is an internal same-origin link
      try {
        const targetUrl = new URL(link.href, window.location.href);
        if (targetUrl.origin === window.location.origin && targetUrl.pathname !== window.location.pathname) {
          e.preventDefault();
          document.body.classList.add('is-page-exiting');
          setTimeout(() => {
            window.location.href = link.href;
          }, 140);
        }
      } catch (err) {
        // Fallback to normal navigation
      }
    });
  }

  // Handle browser back/forward and bfcache recovery (zero stuck screens)
  window.addEventListener('pageshow', (event) => {
    document.body.classList.remove('is-page-exiting');
    if (event.persisted) {
      document.querySelectorAll('.reveal').forEach((el) => el.classList.add('is-visible'));
    }
  });

  /* --------------------------------------------------------------------------
     1. Sticky Header Elevation on Scroll
     -------------------------------------------------------------------------- */
  const header = document.querySelector('.site-header');
  let ticking = false;

  const updateHeaderScroll = () => {
    if (header) {
      if (window.scrollY > 16) {
        header.classList.add('scrolled');
      } else {
        header.classList.remove('scrolled');
      }
    }
    ticking = false;
  };

  window.addEventListener('scroll', () => {
    if (!ticking) {
      window.requestAnimationFrame(updateHeaderScroll);
      ticking = true;
    }
  }, { passive: true });

  updateHeaderScroll();

  /* --------------------------------------------------------------------------
     2. Desktop Apple-Inspired Mega Menu (Hover, Click, Keyboard, Focus Bridge)
     -------------------------------------------------------------------------- */
  const dropdownItems = document.querySelectorAll('.nav-item.has-dropdown');
  let activeDropdown = null;
  let closeTimeout = null;

  const openDropdown = (item) => {
    if (!item) return;

    // Clear any pending close timers
    if (closeTimeout) {
      clearTimeout(closeTimeout);
      closeTimeout = null;
    }

    // Close any other open dropdown
    if (activeDropdown && activeDropdown !== item) {
      closeDropdown(activeDropdown, true);
    }

    const trigger = item.querySelector('.nav-dropdown-btn');
    item.classList.add('is-open');
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'true');
    }
    activeDropdown = item;
  };

  const closeDropdown = (item, immediate = false) => {
    if (!item) return;

    const performClose = () => {
      const trigger = item.querySelector('.nav-dropdown-btn');
      item.classList.remove('is-open');
      if (trigger) {
        trigger.setAttribute('aria-expanded', 'false');
      }
      if (activeDropdown === item) {
        activeDropdown = null;
      }
    };

    if (immediate) {
      if (closeTimeout) {
        clearTimeout(closeTimeout);
        closeTimeout = null;
      }
      performClose();
    } else {
      if (closeTimeout) clearTimeout(closeTimeout);
      // 180ms delay prevents premature closing when cursor glides diagonally
      closeTimeout = setTimeout(() => {
        performClose();
      }, 180);
    }
  };

  dropdownItems.forEach((item) => {
    const trigger = item.querySelector('.nav-dropdown-btn');
    const menu = item.querySelector('.mega-menu');

    // Desktop Mouse Hover (Pointer Enter/Leave)
    item.addEventListener('mouseenter', () => {
      // Only trigger hover on non-touch screens (mouse pointer)
      if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        openDropdown(item);
      }
    });

    item.addEventListener('mouseleave', () => {
      if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        closeDropdown(item);
      }
    });

    // Click / Touch Toggle
    if (trigger) {
      trigger.addEventListener('click', (e) => {
        e.preventDefault();
        const isOpen = item.classList.contains('is-open');
        if (isOpen) {
          closeDropdown(item, true);
        } else {
          openDropdown(item);
        }
      });

      // Keyboard Accessibility (Enter/Space handled natively on button)
      trigger.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          openDropdown(item);
          const firstLink = menu?.querySelector('a');
          if (firstLink) firstLink.focus();
        }
      });
    }

    // Close immediately when any link inside mega menu is clicked
    if (menu) {
      menu.querySelectorAll('a').forEach((link) => {
        link.addEventListener('click', () => {
          closeDropdown(item, true);
        });
      });
    }
  });

  // Global Outside Click to Close Dropdowns
  document.addEventListener('click', (e) => {
    if (activeDropdown && !activeDropdown.contains(e.target)) {
      closeDropdown(activeDropdown, true);
    }
  });

  // Global Escape Key to Close Active Dropdown
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeDropdown) {
      const trigger = activeDropdown.querySelector('.nav-dropdown-btn');
      closeDropdown(activeDropdown, true);
      if (trigger) trigger.focus();
    }
  });

  // Focusout handling: close if focus leaves dropdown completely
  dropdownItems.forEach((item) => {
    item.addEventListener('focusout', (e) => {
      // If focus moves to an element outside this dropdown item, close it
      if (!item.contains(e.relatedTarget)) {
        closeDropdown(item, true);
      }
    });
  });

  /* --------------------------------------------------------------------------
     3. Mobile Navigation Drawer & Expandable Accordions
     -------------------------------------------------------------------------- */
  const menuToggle = document.getElementById('menu-toggle');
  const mobileDrawer = document.getElementById('mobile-drawer');

  const closeMobileMenu = () => {
    if (mobileDrawer && mobileDrawer.classList.contains('is-open')) {
      mobileDrawer.classList.remove('is-open');
      mobileDrawer.setAttribute('hidden', '');
      document.body.classList.remove('nav-locked');
      if (menuToggle) {
        menuToggle.setAttribute('aria-expanded', 'false');
        menuToggle.setAttribute('aria-label', 'Open navigation menu');
      }
    }
  };

  const openMobileMenu = () => {
    if (mobileDrawer) {
      mobileDrawer.removeAttribute('hidden');
      // Trigger display before adding animation class
      requestAnimationFrame(() => {
        mobileDrawer.classList.add('is-open');
      });
      document.body.classList.add('nav-locked');
      if (menuToggle) {
        menuToggle.setAttribute('aria-expanded', 'true');
        menuToggle.setAttribute('aria-label', 'Close navigation menu');
      }
    }
  };

  if (menuToggle && mobileDrawer) {
    menuToggle.addEventListener('click', () => {
      const isOpen = mobileDrawer.classList.contains('is-open');
      if (isOpen) {
        closeMobileMenu();
      } else {
        openMobileMenu();
      }
    });

    // Mobile Accordion Items
    const accordionButtons = mobileDrawer.querySelectorAll('.mobile-accordion-btn');
    accordionButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const panelId = btn.getAttribute('aria-controls');
        const panel = document.getElementById(panelId);
        const isExpanded = btn.getAttribute('aria-expanded') === 'true';

        if (panel) {
          if (isExpanded) {
            btn.setAttribute('aria-expanded', 'false');
            panel.setAttribute('hidden', '');
          } else {
            btn.setAttribute('aria-expanded', 'true');
            panel.removeAttribute('hidden');
          }
        }
      });
    });

    // Close mobile drawer when clicking any link
    mobileDrawer.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => {
        closeMobileMenu();
      });
    });

    // Close on Escape key press
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && mobileDrawer.classList.contains('is-open')) {
        closeMobileMenu();
        menuToggle.focus();
      }
    });
  }

  /* --------------------------------------------------------------------------
     4. Progressive Scroll Reveal System with Stagger & Safety Net
     -------------------------------------------------------------------------- */
  const revealElements = document.querySelectorAll('.reveal');

  // Tag card group containers for automatic staggered transition timing
  const gridSelectors = [
    '.services-grid',
    '.approach-grid',
    '.work-grid',
    '.values-grid',
    '.service-faq-grid',
    '.services-hub-grid',
    '.deliverables-grid'
  ];
  gridSelectors.forEach((sel) => {
    document.querySelectorAll(sel).forEach((grid) => {
      grid.classList.add('stagger-group');
    });
  });

  if (prefersReducedMotion || !('IntersectionObserver' in window)) {
    revealElements.forEach((el) => el.classList.add('is-visible'));
  } else {
    const revealObserver = new IntersectionObserver((entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          obs.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.08,
      rootMargin: '0px 0px -20px 0px'
    });

    revealElements.forEach((el) => revealObserver.observe(el));

    // Safety fallback: Never keep important content hidden indefinitely
    setTimeout(() => {
      document.querySelectorAll('.reveal:not(.is-visible)').forEach((el) => {
        el.classList.add('is-visible');
      });
    }, 2500);
  }

  /* --------------------------------------------------------------------------
     5. Dynamic Copyright Year
     -------------------------------------------------------------------------- */
  const yearElement = document.getElementById('year');
  if (yearElement) {
    yearElement.textContent = new Date().getFullYear();
  }

  /* --------------------------------------------------------------------------
     6. Copy Direct Email to Clipboard
     -------------------------------------------------------------------------- */
  /* --------------------------------------------------------------------------
     PHASE 8 CONFIGURATION: Form Delivery Backend & WhatsApp Contact
     -------------------------------------------------------------------------- */
  /**
   * FORM BACKEND DELIVERY CONFIGURATION
   * 
   * Architecture Note:
   * Nexora Nexus is built on a clean, static frontend architecture.
   * To enable automated direct server delivery of inquiries without opening a desktop email client:
   * 1. Sign up for a trusted form endpoint provider (such as Formspree, Basin, Formkeep, Getform)
   *    or deploy a secure serverless webhook / API route (AWS Lambda, Cloudflare Worker, Vercel Serverless).
   * 2. Set your public endpoint URL below in `endpoint`.
   * 
   * SECURITY NOTICE:
   * Never embed private API keys, SMTP credentials, database passwords, or secret tokens
   * in frontend client code. Public form endpoints (e.g., https://formspree.io/f/YOUR_FORM_ID)
   * are designed to receive POST requests without exposing credentials.
   * 
   * When `endpoint` is empty (''), direct server delivery is not configured.
   * The form honestly informs the visitor, preserves entered details, and provides
   * one-click options to open a pre-filled email client draft or copy the formatted text.
   */
  const FORM_BACKEND_CONFIG = {
    endpoint: '', // Public POST endpoint URL (e.g. 'https://formspree.io/f/your_form_id' or '/api/contact')
    targetEmail: 'hello@nexoranexus.com'
  };

  /**
   * WHATSAPP CONTACT CONFIGURATION
   * 
   * Instructions:
   * Replace `phoneNumber` with the official company WhatsApp Business number
   * in international E.164 format without '+', spaces, or symbols (e.g. '919876543210' for India).
   * 
   * If left as empty string (''), the floating WhatsApp button remains active but displays
   * a helpful informational dialog indicating that the business line is awaiting setup,
   * avoiding fake or invented numbers.
   */
  const WHATSAPP_CONFIG = {
    phoneNumber: '', // Configuration placeholder: Awaiting official business WhatsApp number
    defaultMessage: 'Hello Nexora Nexus team, I would like to inquire about your engineering services for an upcoming project.'
  };

  /* --------------------------------------------------------------------------
     6. Copy Direct Email to Clipboard & Modal Alert Dialog
     -------------------------------------------------------------------------- */
  const copyBtn = document.getElementById('copy-email-btn');
  const copyText = document.getElementById('copy-text');
  const targetEmail = FORM_BACKEND_CONFIG.targetEmail;

  if (copyBtn && copyText) {
    copyBtn.addEventListener('click', async () => {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(targetEmail);
        } else {
          const textArea = document.createElement('textarea');
          textArea.value = targetEmail;
          textArea.style.position = 'fixed';
          textArea.style.left = '-9999px';
          document.body.appendChild(textArea);
          textArea.select();
          document.execCommand('copy');
          document.body.removeChild(textArea);
        }

        const originalText = copyText.textContent;
        copyText.textContent = 'Copied to clipboard! ✓';
        copyBtn.style.backgroundColor = '#ecfdf5';
        copyBtn.style.borderColor = '#10b981';
        copyBtn.style.color = '#065f46';

        setTimeout(() => {
          copyText.textContent = originalText;
          copyBtn.style.backgroundColor = '';
          copyBtn.style.borderColor = '';
          copyBtn.style.color = '';
        }, 2500);
      } catch (err) {
        copyText.textContent = `Write to: ${targetEmail}`;
      }
    });
  }

  /**
   * Accessible Informational Dialog Modal
   */
  const showContactDialog = ({ title, message, actionText, actionHref }) => {
    let overlay = document.getElementById('contact-dialog-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'contact-dialog-overlay';
      overlay.className = 'contact-dialog-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'contact-dialog-title');
      overlay.innerHTML = `
        <div class="contact-dialog-card">
          <h3 id="contact-dialog-title"></h3>
          <div id="contact-dialog-message"></div>
          <div class="contact-dialog-actions">
            <button type="button" class="button button-outline button-sm" id="contact-dialog-close">Dismiss</button>
            <a href="#" class="button button-primary button-sm" id="contact-dialog-action" style="display: none;"></a>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const closeBtn = overlay.querySelector('#contact-dialog-close');
      const closeDialog = () => {
        overlay.classList.remove('is-active');
        document.removeEventListener('keydown', handleKeyDown);
      };
      const handleKeyDown = (e) => {
        if (e.key === 'Escape') closeDialog();
      };

      closeBtn.addEventListener('click', closeDialog);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeDialog();
      });
    }

    const titleEl = overlay.querySelector('#contact-dialog-title');
    const msgEl = overlay.querySelector('#contact-dialog-message');
    const actionEl = overlay.querySelector('#contact-dialog-action');

    titleEl.textContent = title;
    msgEl.innerHTML = `<p>${message}</p>`;

    if (actionText && actionHref) {
      actionEl.style.display = 'inline-flex';
      actionEl.textContent = actionText;
      actionEl.href = actionHref;
    } else {
      actionEl.style.display = 'none';
    }

    overlay.classList.add('is-active');
    const closeBtn = overlay.querySelector('#contact-dialog-close');
    if (closeBtn) closeBtn.focus();
  };

  /* --------------------------------------------------------------------------
     6.5 Service-Aware Query Parameter (?service=...)
     -------------------------------------------------------------------------- */
  const OFFICIAL_SERVICES = [
    { slug: 'website-development', name: 'Website Development' },
    { slug: 'software-development', name: 'Software Development' },
    { slug: 'mobile-app-development', name: 'Mobile App Development' },
    { slug: 'ai-machine-learning', name: 'Artificial Intelligence (AI) & Machine Learning' },
    { slug: 'digital-marketing-seo', name: 'Digital Marketing & SEO' },
    { slug: 'cloud-computing', name: 'Cloud Computing' },
    { slug: 'cybersecurity', name: 'Cybersecurity' },
    { slug: 'ecommerce-development', name: 'E-commerce Development' },
    { slug: 'ui-ux-design', name: 'UI/UX Design' },
    { slug: 'data-analytics-bi', name: 'Data Analytics & Business Intelligence' },
    { slug: 'devops-automation', name: 'DevOps & Automation' },
    { slug: 'saas-development', name: 'SaaS Product Development' },
    { slug: 'api-development-integration', name: 'API Development & Integration' },
    { slug: 'it-consulting-digital-transformation', name: 'IT Consulting & Digital Transformation' },
    { slug: 'software-testing-qa', name: 'Software Testing & Quality Assurance' }
  ];

  const urlParams = new URLSearchParams(window.location.search);
  const serviceParam = urlParams.get('service');
  const serviceSelect = document.getElementById('service');
  const preselectedContainer = document.getElementById('service-preselected-container');

  if (serviceParam && serviceSelect) {
    const paramClean = serviceParam.toLowerCase().trim();
    const matchedService = OFFICIAL_SERVICES.find(s => 
      s.slug === paramClean || s.name.toLowerCase() === paramClean
    );

    if (matchedService) {
      // Find matching option in select element
      for (let i = 0; i < serviceSelect.options.length; i++) {
        if (serviceSelect.options[i].value === matchedService.name) {
          serviceSelect.selectedIndex = i;
          break;
        }
      }

      // Display visual confirmation badge above form
      if (preselectedContainer) {
        preselectedContainer.innerHTML = `
          <div class="service-preselected-badge" role="status">
            <span class="badge-icon" aria-hidden="true">✓</span>
            <span>Preselected Service: <strong>${matchedService.name}</strong></span>
            <span class="badge-note">(Context passed from service page · Change anytime)</span>
          </div>
        `;
      }
    }
  }

  /* --------------------------------------------------------------------------
     7. Contact Form Validation, Spam Protection & Delivery Pipeline
     -------------------------------------------------------------------------- */
  const contactForm = document.getElementById('contact-form');
  const formStatus = document.getElementById('form-status');
  const submitBtn = document.getElementById('form-submit-btn');

  const escapeHtml = (str) => {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  // Helper to wire copy inquiry button
  const wireCopyInquiryButton = (text) => {
    const copyInquiryBtn = document.getElementById('copy-assembled-inquiry-btn');
    if (!copyInquiryBtn) return;
    copyInquiryBtn.addEventListener('click', async () => {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        const prevText = copyInquiryBtn.textContent;
        copyInquiryBtn.textContent = 'Copied to Clipboard! ✓';
        copyInquiryBtn.style.backgroundColor = '#ecfdf5';
        copyInquiryBtn.style.color = '#065f46';
        setTimeout(() => {
          copyInquiryBtn.textContent = prevText;
          copyInquiryBtn.style.backgroundColor = '';
          copyInquiryBtn.style.color = '';
        }, 2500);
      } catch (err) {
        copyInquiryBtn.textContent = 'Please select text manually';
      }
    });
  };

  if (contactForm && formStatus) {
    const inputs = contactForm.querySelectorAll('input:not([name="website_url"]), select, textarea');

    // Helper to set field error
    const setFieldError = (field, errorMsg) => {
      field.classList.add('input-error');
      field.setAttribute('aria-invalid', 'true');
      const errSpan = document.getElementById(`${field.id}-error`);
      if (errSpan) {
        errSpan.textContent = errorMsg;
      }
    };

    // Helper to clear field error
    const clearFieldError = (field) => {
      field.classList.remove('input-error');
      field.setAttribute('aria-invalid', 'false');
      const errSpan = document.getElementById(`${field.id}-error`);
      if (errSpan) {
        errSpan.textContent = '';
      }
    };

    // Real-time validation feedback on blur and input
    inputs.forEach((input) => {
      input.addEventListener('blur', () => {
        if (!input.checkValidity()) {
          setFieldError(input, input.validationMessage);
        } else {
          clearFieldError(input);
        }
      });

      input.addEventListener('input', () => {
        if (input.checkValidity()) {
          clearFieldError(input);
        }
      });

      if (input.tagName === 'SELECT') {
        input.addEventListener('change', () => {
          if (input.checkValidity()) {
            clearFieldError(input);
          }
        });
      }
    });

    contactForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      // Basic Spam Protection: Check Honeypot Field
      const honeypotVal = contactForm.querySelector('input[name="website_url"]')?.value;
      if (honeypotVal && honeypotVal.trim() !== '') {
        // Bot detected: Silently abort without alerting the bot or transmitting data
        formStatus.className = 'form-status active success';
        formStatus.innerHTML = `<strong>Inquiry Received!</strong> Thank you for reaching out.`;
        contactForm.reset();
        return;
      }

      // Validate required fields
      let isValid = true;
      let firstInvalid = null;

      const nameInput = document.getElementById('name');
      const emailInput = document.getElementById('email');
      const serviceInput = document.getElementById('service');
      const messageInput = document.getElementById('message');

      // Clear all existing error messages
      [nameInput, emailInput, serviceInput, messageInput].forEach(f => f && clearFieldError(f));

      // 1. Name validation
      if (!nameInput.value.trim()) {
        setFieldError(nameInput, 'Please provide your full name.');
        isValid = false;
        if (!firstInvalid) firstInvalid = nameInput;
      }

      // 2. Work email validation (RFC compliant format check)
      const emailPattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/;
      if (!emailInput.value.trim()) {
        setFieldError(emailInput, 'Please provide your work email address.');
        isValid = false;
        if (!firstInvalid) firstInvalid = emailInput;
      } else if (!emailPattern.test(emailInput.value.trim())) {
        setFieldError(emailInput, 'Please enter a valid work email format (e.g. name@company.com).');
        isValid = false;
        if (!firstInvalid) firstInvalid = emailInput;
      }

      // 3. Service validation
      if (!serviceInput.value.trim()) {
        setFieldError(serviceInput, 'Please select an engineering service category.');
        isValid = false;
        if (!firstInvalid) firstInvalid = serviceInput;
      }

      // 4. Project message validation
      if (!messageInput.value.trim()) {
        setFieldError(messageInput, 'Please describe your project or technical requirements.');
        isValid = false;
        if (!firstInvalid) firstInvalid = messageInput;
      } else if (messageInput.value.trim().length < 15) {
        setFieldError(messageInput, 'Please provide at least 15 characters describing your project.');
        isValid = false;
        if (!firstInvalid) firstInvalid = messageInput;
      }

      if (!isValid) {
        formStatus.className = 'form-status active warning';
        formStatus.innerHTML = '<strong>Inquiry Incomplete:</strong> Please correct the highlighted fields above.';
        if (firstInvalid) {
          firstInvalid.classList.add('input-shake');
          firstInvalid.focus();
          setTimeout(() => firstInvalid.classList.remove('input-shake'), 350);
        }
        return;
      }

      // Collect form values
      const formData = new FormData(contactForm);
      const name = formData.get('name')?.toString().trim();
      const email = formData.get('email')?.toString().trim();
      const company = formData.get('company')?.toString().trim() || 'Not specified';
      const service = formData.get('service')?.toString().trim();
      const budget = formData.get('budget')?.toString().trim() || 'Not specified';
      const timeline = formData.get('timeline')?.toString().trim() || 'Not specified';
      const message = formData.get('message')?.toString().trim();

      // Assemble formatted message body
      const inquiryBody = 
`Hi Nexora Nexus Engineering Team,

I would like to discuss an upcoming software / engineering engagement.

--- INQUIRY OVERVIEW ---
Full Name: ${name}
Work Email: ${email}
Company: ${company}
Service Required: ${service}
Budget Range: ${budget}
Project Timeline: ${timeline}

--- PROJECT DESCRIPTION ---
${message}

---
Inquiry submitted via Nexora Nexus Web Portal (${new Date().toLocaleDateString()})`;

      const mailtoSubject = encodeURIComponent(`Project Inquiry: ${name} (${company}) — ${service}`);
      const mailtoUrl = `mailto:${FORM_BACKEND_CONFIG.targetEmail}?subject=${mailtoSubject}&body=${encodeURIComponent(inquiryBody)}`;

      // Scenario A: Form Backend Endpoint is Configured
      if (FORM_BACKEND_CONFIG.endpoint && FORM_BACKEND_CONFIG.endpoint.trim() !== '') {
        const originalBtnHtml = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<span>Submitting Securely...</span>`;

        formStatus.className = 'form-status active info';
        formStatus.innerHTML = `<span>Transmitting your inquiry over encrypted HTTPS...</span>`;

        try {
          const response = await fetch(FORM_BACKEND_CONFIG.endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({
              name,
              email,
              company,
              service,
              budget,
              timeline,
              message,
              source: window.location.href,
              submittedAt: new Date().toISOString()
            })
          });

          if (response.ok) {
            formStatus.className = 'form-status active success';
            formStatus.innerHTML = `
              <strong>✓ Inquiry Transmitted Successfully!</strong><br>
              Thank you, <b>${escapeHtml(name)}</b>. Your project inquiry has been securely received by our technical leads at <code>${FORM_BACKEND_CONFIG.targetEmail}</code>.<br>
              We evaluate every inquiry with NDA-grade confidentiality.
            `;
            contactForm.reset();
            if (preselectedContainer) preselectedContainer.innerHTML = '';
          } else {
            throw new Error(`Endpoint returned HTTP ${response.status}`);
          }
        } catch (fetchErr) {
          formStatus.className = 'form-status active error';
          formStatus.innerHTML = `
            <strong>Submission Service Unavailable (${fetchErr.message || 'Network error'}).</strong><br>
            Automated server delivery could not be completed. Your inquiry details have been preserved below so nothing is lost.<br>
            Please dispatch via your email client or copy the formatted inquiry:
            <div class="form-status-actions">
              <a href="${mailtoUrl}" class="button button-primary button-sm">Open in Email Client (mailto:) ↗</a>
              <button type="button" class="button button-secondary button-sm" id="copy-assembled-inquiry-btn">Copy Formatted Text 📋</button>
            </div>
          `;
          wireCopyInquiryButton(inquiryBody);
        } finally {
          submitBtn.disabled = false;
          submitBtn.innerHTML = originalBtnHtml;
        }
      } 
      // Scenario B: Form Backend Endpoint is NOT Configured (Transparent Static Notice)
      else {
        formStatus.className = 'form-status active notice';
        formStatus.innerHTML = `
          <strong>Inquiry Assembled — Direct Server Delivery Awaiting Configuration</strong>
          <p style="margin: 6px 0 10px; font-size: 12px; color: var(--text-secondary); line-height: 1.5;">
            Direct server submission is not currently connected on this static deployment (no backend endpoint configured in <code>FORM_BACKEND_CONFIG.endpoint</code>).
            Your inquiry has been assembled below — you can open it directly in your email client or copy the formatted details to send to <strong>${FORM_BACKEND_CONFIG.targetEmail}</strong>.
          </p>
          <div class="form-status-actions">
            <a href="${mailtoUrl}" class="button button-primary button-sm" id="dispatch-mailto-link">
              Open in Email Client (mailto:) ↗
            </a>
            <button type="button" class="button button-secondary button-sm" id="copy-assembled-inquiry-btn">
              Copy Formatted Text 📋
            </button>
          </div>
          <div class="form-inquiry-preview" title="Assembled Inquiry Preview">${escapeHtml(inquiryBody)}</div>
        `;

        wireCopyInquiryButton(inquiryBody);
      }
    });
  }

  /* --------------------------------------------------------------------------
     7.5 Interactive FAQ Accordion System (Progressive Enhancement)
     -------------------------------------------------------------------------- */
  const faqCards = document.querySelectorAll('.faq-card');
  if (faqCards.length) {
    faqCards.forEach((card, index) => {
      const heading = card.querySelector('h3');
      const paragraph = card.querySelector('p');
      if (!heading || !paragraph) return;

      const questionText = heading.textContent.trim();
      const collapseId = `faq-answer-${index + 1}`;

      // Build collapsible answer wrap
      const collapseWrap = document.createElement('div');
      collapseWrap.className = 'faq-answer-collapse is-closed';
      collapseWrap.id = collapseId;
      collapseWrap.setAttribute('role', 'region');

      const innerWrap = document.createElement('div');
      innerWrap.className = 'faq-answer-inner';
      innerWrap.appendChild(paragraph);
      collapseWrap.appendChild(innerWrap);

      // Build interactive trigger button
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'faq-card-trigger';
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-controls', collapseId);

      const titleEl = document.createElement('h3');
      titleEl.textContent = questionText;

      const chevronEl = document.createElement('span');
      chevronEl.className = 'faq-chevron';
      chevronEl.setAttribute('aria-hidden', 'true');
      chevronEl.innerHTML = `
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
          <path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;

      button.appendChild(titleEl);
      button.appendChild(chevronEl);

      // Reset card content with accessible trigger and collapsible region
      card.innerHTML = '';
      card.appendChild(button);
      card.appendChild(collapseWrap);

      // Smooth click and keyboard toggling
      button.addEventListener('click', () => {
        const isExpanded = button.getAttribute('aria-expanded') === 'true';
        if (isExpanded) {
          button.setAttribute('aria-expanded', 'false');
          collapseWrap.classList.add('is-closed');
        } else {
          button.setAttribute('aria-expanded', 'true');
          collapseWrap.classList.remove('is-closed');
        }
      });
    });
  }

  /* --------------------------------------------------------------------------
     8. Multi-Style 3D Experiences
     -------------------------------------------------------------------------- */

  /**
   * Animation A: Floating Glass Orbs with Mouse-Responsive Parallax (Hero)
   */
  const initGlassOrbs = () => {
    const hero = document.querySelector('.hero.has-3d-orbs');
    if (!hero) return;

    const orbs = hero.querySelectorAll('.glass-orb');
    if (!orbs.length) return;

    if (prefersReducedMotion) return; // Keep static positions

    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;
    let isVisible = true;
    let rafId = null;

    const onMouseMove = (e) => {
      const rect = hero.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      targetX = Math.max(-0.5, Math.min(0.5, x));
      targetY = Math.max(-0.5, Math.min(0.5, y));
    };

    const onMouseLeave = () => {
      targetX = 0;
      targetY = 0;
    };

    const updateParallax = () => {
      if (!isVisible || document.hidden) return;
      currentX += (targetX - currentX) * 0.05;
      currentY += (targetY - currentY) * 0.05;

      orbs.forEach((orb) => {
        const depth = parseFloat(orb.dataset.depth || '0.4');
        const px = currentX * depth * 50;
        const py = currentY * depth * 50;
        orb.style.setProperty('--parallax-x', `${px.toFixed(2)}px`);
        orb.style.setProperty('--parallax-y', `${py.toFixed(2)}px`);
      });

      rafId = requestAnimationFrame(updateParallax);
    };

    hero.addEventListener('mousemove', onMouseMove, { passive: true });
    hero.addEventListener('mouseleave', onMouseLeave, { passive: true });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      } else {
        if (isVisible && !rafId) {
          rafId = requestAnimationFrame(updateParallax);
        }
      }
    });

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        isVisible = entry.isIntersecting;
        if (isVisible && !document.hidden) {
          if (!rafId) rafId = requestAnimationFrame(updateParallax);
        } else {
          if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
        }
      });
    }, { threshold: 0.05 });

    observer.observe(hero);
  };

  /**
   * Animation B: Flowing 3D Ribbons (About, Services, Approach)
   */
  const initFlowingRibbons = () => {
    const canvases = document.querySelectorAll('.canvas-3d-ribbons');
    if (!canvases.length) return;

    canvases.forEach((canvas) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const parent = canvas.parentElement;
      let width = 0;
      let height = 0;
      let isVisible = false;
      let rafId = null;
      let time = Math.random() * 100;

      const resize = () => {
        const rect = parent.getBoundingClientRect();
        width = rect.width;
        height = rect.height;
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        ctx.resetTransform();
        ctx.scale(dpr, dpr);
      };

      resize();
      let resizeTimer = null;
      window.addEventListener('resize', () => {
        if (resizeTimer) cancelAnimationFrame(resizeTimer);
        resizeTimer = requestAnimationFrame(() => {
          resize();
          if (prefersReducedMotion) drawRibbonFrame();
        });
      }, { passive: true });

      // Configuration of multi-layer organic ribbons
      const isMobile = width <= 768;
      const ribbons = [
        {
          baseRatio: 0.38,
          amp1: isMobile ? 22 : 36,
          amp2: isMobile ? 12 : 18,
          freq1: 0.0016,
          freq2: 0.0032,
          speed: 0.0007,
          thickness: isMobile ? 55 : 85,
          phase: 0,
          colorStops: [
            [0, 'rgba(0, 102, 204, 0.03)'],
            [0.4, 'rgba(56, 189, 248, 0.12)'],
            [0.7, 'rgba(255, 255, 255, 0.45)'],
            [1, 'rgba(0, 102, 204, 0.05)']
          ],
          edgeColor: 'rgba(0, 102, 204, 0.22)'
        },
        {
          baseRatio: 0.58,
          amp1: isMobile ? 26 : 46,
          amp2: isMobile ? 14 : 22,
          freq1: 0.0019,
          freq2: 0.0028,
          speed: 0.0009,
          thickness: isMobile ? 65 : 105,
          phase: 2.3,
          colorStops: [
            [0, 'rgba(56, 189, 248, 0.04)'],
            [0.35, 'rgba(0, 102, 204, 0.09)'],
            [0.75, 'rgba(255, 255, 255, 0.5)'],
            [1, 'rgba(0, 102, 204, 0.02)']
          ],
          edgeColor: 'rgba(56, 189, 248, 0.26)'
        }
      ];

      if (!isMobile) {
        ribbons.push({
          baseRatio: 0.74,
          amp1: 28,
          amp2: 15,
          freq1: 0.0023,
          freq2: 0.0041,
          speed: 0.0011,
          thickness: 70,
          phase: 4.1,
          colorStops: [
            [0, 'rgba(0, 102, 204, 0.05)'],
            [0.5, 'rgba(255, 255, 255, 0.38)'],
            [1, 'rgba(56, 189, 248, 0.07)']
          ],
          edgeColor: 'rgba(0, 102, 204, 0.18)'
        });
      }

      const drawRibbonFrame = () => {
        ctx.clearRect(0, 0, width, height);

        ribbons.forEach((r) => {
          const baseY = height * r.baseRatio;
          const step = 18;
          const pointsTop = [];
          const pointsBottom = [];

          for (let x = 0; x <= width + step; x += step) {
            const t = time * r.speed;
            const yOffset = Math.sin(x * r.freq1 + t + r.phase) * r.amp1 +
                            Math.cos(x * r.freq2 - t * 0.7 + r.phase * 0.5) * r.amp2;
            const twist = Math.sin(x * 0.0022 + t * 0.8 + r.phase);
            const curH = r.thickness * (0.8 + 0.35 * twist);

            const yTop = baseY + yOffset;
            const yBottom = yTop + curH;

            pointsTop.push({ x, y: yTop });
            pointsBottom.push({ x, y: yBottom });
          }

          if (pointsTop.length < 2) return;

          // Draw ribbon body with linear gradient
          ctx.beginPath();
          ctx.moveTo(pointsTop[0].x, pointsTop[0].y);
          for (let i = 1; i < pointsTop.length; i++) {
            ctx.lineTo(pointsTop[i].x, pointsTop[i].y);
          }
          for (let i = pointsBottom.length - 1; i >= 0; i--) {
            ctx.lineTo(pointsBottom[i].x, pointsBottom[i].y);
          }
          ctx.closePath();

          const grad = ctx.createLinearGradient(0, baseY - r.amp1, 0, baseY + r.thickness + r.amp1);
          r.colorStops.forEach(([stop, color]) => grad.addColorStop(stop, color));
          ctx.fillStyle = grad;
          ctx.fill();

          // Luminous hairline top edge
          ctx.beginPath();
          ctx.moveTo(pointsTop[0].x, pointsTop[0].y);
          for (let i = 1; i < pointsTop.length; i++) {
            ctx.lineTo(pointsTop[i].x, pointsTop[i].y);
          }
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = r.edgeColor;
          ctx.stroke();
        });
      };

      const animate = (timestamp) => {
        if (!isVisible || document.hidden) return;
        time += 1.0;
        drawRibbonFrame();
        rafId = requestAnimationFrame(animate);
      };

      if (prefersReducedMotion) {
        drawRibbonFrame();
        return;
      }

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
        } else {
          if (isVisible && !rafId) {
            rafId = requestAnimationFrame(animate);
          }
        }
      });

      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          isVisible = entry.isIntersecting;
          if (isVisible && !document.hidden) {
            if (!rafId) rafId = requestAnimationFrame(animate);
          } else {
            if (rafId) {
              cancelAnimationFrame(rafId);
              rafId = null;
            }
          }
        });
      }, { threshold: 0.05 });

      observer.observe(parent);
    });
  };

  /**
   * Animation C: Interactive 3D Network (Technology Sections)
   */
  const initInteractiveNetwork = () => {
    const canvases = document.querySelectorAll('.canvas-3d-network');
    if (!canvases.length) return;

    canvases.forEach((canvas) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const parent = canvas.parentElement;
      let width = 0;
      let height = 0;
      let isVisible = false;
      let rafId = null;

      let rotY = 0;
      let rotX = 0;
      let tiltX = 0;
      let tiltY = 0;
      let targetTiltX = 0;
      let targetTiltY = 0;
      let mouseX = -9999;
      let mouseY = -9999;

      const resize = () => {
        const rect = parent.getBoundingClientRect();
        width = rect.width;
        height = rect.height;
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        ctx.resetTransform();
        ctx.scale(dpr, dpr);
      };

      resize();
      let resizeTimer = null;
      window.addEventListener('resize', () => {
        if (resizeTimer) cancelAnimationFrame(resizeTimer);
        resizeTimer = requestAnimationFrame(() => {
          resize();
          if (prefersReducedMotion) drawNetworkFrame();
        });
      }, { passive: true });

      // Generate 3D point cloud
      const nodeCount = width > 1024 ? 36 : (width > 768 ? 22 : 14);
      const nodes = [];
      const spreadX = Math.min(width * 0.38, 280);
      const spreadY = Math.min(height * 0.38, 160);
      const spreadZ = 200;

      for (let i = 0; i < nodeCount; i++) {
        nodes.push({
          x: (Math.random() - 0.5) * spreadX * 2,
          y: (Math.random() - 0.5) * spreadY * 2,
          z: (Math.random() - 0.5) * spreadZ * 2,
          vx: (Math.random() - 0.5) * 0.25,
          vy: (Math.random() - 0.5) * 0.25,
          vz: (Math.random() - 0.5) * 0.25,
          glow: 0
        });
      }

      // Restrained Desktop Mouse Interaction
      const onMouseMove = (e) => {
        const rect = parent.getBoundingClientRect();
        mouseX = e.clientX - rect.left;
        mouseY = e.clientY - rect.top;
        targetTiltX = (mouseY / height - 0.5) * 0.35;
        targetTiltY = (mouseX / width - 0.5) * 0.45;
      };

      const onMouseLeave = () => {
        mouseX = -9999;
        mouseY = -9999;
        targetTiltX = 0;
        targetTiltY = 0;
      };

      parent.addEventListener('mousemove', onMouseMove, { passive: true });
      parent.addEventListener('mouseleave', onMouseLeave, { passive: true });

      const drawNetworkFrame = () => {
        ctx.clearRect(0, 0, width, height);

        // Slow autonomous rotation + gentle tilt
        if (!prefersReducedMotion) {
          rotY += 0.0015;
          rotX = Math.sin(rotY * 0.6) * 0.14;
          tiltX += (targetTiltX - tiltX) * 0.05;
          tiltY += (targetTiltY - tiltY) * 0.05;
        }

        const totalRotY = rotY + tiltY;
        const totalRotX = rotX + tiltX;
        const cosY = Math.cos(totalRotY);
        const sinY = Math.sin(totalRotY);
        const cosX = Math.cos(totalRotX);
        const sinX = Math.sin(totalRotX);

        const fov = 550;
        const cameraDist = 480;
        // Position network towards the right on wide displays to frame heading
        const centerX = width > 900 ? width * 0.72 : width * 0.5;
        const centerY = height * 0.5;

        // Project nodes to 2D
        const projected = [];
        nodes.forEach((n) => {
          if (!prefersReducedMotion) {
            n.x += n.vx;
            n.y += n.vy;
            n.z += n.vz;
            if (Math.abs(n.x) > spreadX) n.vx *= -1;
            if (Math.abs(n.y) > spreadY) n.vy *= -1;
            if (Math.abs(n.z) > spreadZ) n.vz *= -1;
          }

          // 3D rotation
          const x1 = n.x * cosY - n.z * sinY;
          const z1 = n.z * cosY + n.x * sinY;
          const y1 = n.y * cosX - z1 * sinX;
          const z2 = z1 * cosX + n.y * sinX;

          const scale = fov / (z2 + cameraDist);
          const px = centerX + x1 * scale;
          const py = centerY + y1 * scale;

          // Proximity glow
          const distToMouse = Math.hypot(px - mouseX, py - mouseY);
          if (distToMouse < 120) {
            n.glow = Math.min(1, n.glow + 0.12);
          } else {
            n.glow *= 0.94;
          }

          projected.push({ x: px, y: py, scale, z: z2, glow: n.glow });
        });

        // Draw connections between proximate nodes
        const maxDist = width <= 768 ? 95 : 130;
        for (let i = 0; i < projected.length; i++) {
          for (let j = i + 1; j < projected.length; j++) {
            const p1 = projected[i];
            const p2 = projected[j];
            const dx = p1.x - p2.x;
            const dy = p1.y - p2.y;
            const dist = Math.hypot(dx, dy);

            if (dist < maxDist) {
              const alpha = (1 - dist / maxDist) * 0.22 * Math.min(p1.scale, p2.scale);
              ctx.beginPath();
              ctx.moveTo(p1.x, p1.y);
              ctx.lineTo(p2.x, p2.y);
              ctx.lineWidth = Math.max(0.6, 0.9 * Math.min(p1.scale, p2.scale));

              if (p1.glow > 0.2 || p2.glow > 0.2) {
                ctx.strokeStyle = `rgba(56, 189, 248, ${(alpha * 1.8).toFixed(3)})`;
              } else {
                ctx.strokeStyle = `rgba(0, 102, 204, ${alpha.toFixed(3)})`;
              }
              ctx.stroke();
            }
          }
        }

        // Draw node points
        projected.forEach((p) => {
          const r = Math.max(1.8, (2.2 + p.glow * 1.8) * p.scale);

          // Soft halo
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(56, 189, 248, ${(0.15 + p.glow * 0.3).toFixed(3)})`;
          ctx.fill();

          // Node core
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fillStyle = p.glow > 0.3 ? '#0066cc' : 'rgba(0, 102, 204, 0.85)';
          ctx.fill();
        });
      };

      const animate = () => {
        if (!isVisible || document.hidden) return;
        drawNetworkFrame();
        rafId = requestAnimationFrame(animate);
      };

      if (prefersReducedMotion) {
        drawNetworkFrame();
        return;
      }

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
        } else {
          if (isVisible && !rafId) {
            rafId = requestAnimationFrame(animate);
          }
        }
      });

      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          isVisible = entry.isIntersecting;
          if (isVisible && !document.hidden) {
            if (!rafId) rafId = requestAnimationFrame(animate);
          } else {
            if (rafId) {
              cancelAnimationFrame(rafId);
              rafId = null;
            }
          }
        });
      }, { threshold: 0.05 });

      observer.observe(parent);
    });
  };

  /* --------------------------------------------------------------------------
     8. Floating WhatsApp Contact Button (Discreet & Accessible)
     -------------------------------------------------------------------------- */
  const initWhatsAppFloatingButton = () => {
    if (document.getElementById('whatsapp-floating-wrap')) return;

    const wrap = document.createElement('aside');
    wrap.className = 'whatsapp-floating-wrap';
    wrap.id = 'whatsapp-floating-wrap';
    wrap.setAttribute('aria-label', 'Direct messaging channel');

    const btn = document.createElement('a');
    btn.className = 'whatsapp-floating-btn';
    btn.id = 'whatsapp-floating-btn';
    btn.setAttribute('aria-label', 'Chat with Nexora Nexus on WhatsApp');

    const isConfigured = WHATSAPP_CONFIG.phoneNumber && WHATSAPP_CONFIG.phoneNumber.trim().length > 0;

    if (isConfigured) {
      const cleanNumber = WHATSAPP_CONFIG.phoneNumber.replace(/[^0-9]/g, '');
      const encodedMsg = encodeURIComponent(WHATSAPP_CONFIG.defaultMessage);
      btn.href = `https://wa.me/${cleanNumber}?text=${encodedMsg}`;
      btn.target = '_blank';
      btn.rel = 'noopener noreferrer';
    } else {
      btn.href = '#whatsapp-contact';
      btn.setAttribute('role', 'button');
    }

    btn.innerHTML = `
      <span class="whatsapp-icon-svg" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
          <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91C2.13 13.66 2.59 15.36 3.45 16.86L2.05 22L7.3 20.62C8.75 21.41 10.38 21.83 12.04 21.83C17.5 21.83 21.95 17.38 21.95 11.92C21.95 9.27 20.92 6.78 19.05 4.91C17.18 3.03 14.69 2 12.04 2M12.05 3.67C14.25 3.67 16.31 4.53 17.87 6.09C19.42 7.65 20.28 9.72 20.28 11.92C20.28 16.46 16.58 20.15 12.04 20.15C10.56 20.15 9.11 19.76 7.85 19.01L7.55 18.83L4.44 19.65L5.27 16.61L5.07 16.3C4.24 14.98 3.8 13.47 3.8 11.91C3.81 7.37 7.5 3.67 12.05 3.67M9.53 7.34C9.36 7.34 9.09 7.4 8.87 7.65C8.64 7.89 8 8.49 8 9.72C8 10.95 8.89 12.13 9.02 12.3C9.14 12.47 10.77 15.08 13.3 16.09C15.4 16.94 15.83 16.77 16.28 16.73C16.74 16.69 17.75 16.13 17.96 15.55C18.17 14.96 18.17 14.46 18.1 14.36C18.04 14.25 17.88 14.19 17.64 14.07C17.39 13.95 16.19 13.36 15.96 13.28C15.74 13.19 15.58 13.15 15.41 13.4C15.25 13.65 14.78 14.19 14.63 14.36C14.49 14.52 14.35 14.54 14.1 14.42C13.86 14.3 12.83 13.96 11.61 12.87C10.66 12.02 10.02 10.98 9.89 10.74C9.77 10.49 9.88 10.36 10.24C10.11 10.13 10.25 9.95 10.37 9.81C10.49 9.66 10.54 9.56 10.62 9.4C10.7 9.23 10.66 9.09 10.6 8.97C10.54 8.84 10.07 7.68 9.87 7.21C9.68 6.74 9.48 6.81 9.34 6.81C9.2 6.81 9.04 6.81 8.87 6.81L9.53 7.34Z"/>
        </svg>
      </span>
      <span class="whatsapp-btn-label">Chat with Us</span>
    `;

    wrap.appendChild(btn);
    document.body.appendChild(wrap);

    if (!isConfigured) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        showContactDialog({
          title: 'WhatsApp Business Channel',
          message: 'The official Nexora Nexus WhatsApp business line is currently awaiting phone number provisioning in <code>WHATSAPP_CONFIG.phoneNumber</code>.<br><br>In the meantime, please send us an inquiry via our project form or email our engineering leads directly at <strong>hello@nexoranexus.com</strong>.',
          actionText: 'Email Us Directly',
          actionHref: 'mailto:hello@nexoranexus.com?subject=Project%20Inquiry%20via%20Nexora%20Nexus'
        });
      });
    }
  };

  // Initialize all experiences & Phase 8 integrations
  initGlassOrbs();
  initFlowingRibbons();
  initInteractiveNetwork();
  initWhatsAppFloatingButton();
});

