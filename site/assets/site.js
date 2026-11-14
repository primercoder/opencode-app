(function () {
  var root = document.documentElement;
  var zh = (root.lang || "").toLowerCase().indexOf("zh") === 0;
  var reduceMotion =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ----------------------------------------------------------------
     Theme
     ---------------------------------------------------------------- */

  var themeToggle = document.querySelector("[data-theme-toggle]");
  var themeMeta = document.querySelector('meta[name="theme-color"]');

  function themeLabel(theme) {
    if (zh) {
      return theme === "dark" ? "切换到浅色模式" : "切换到深色模式";
    }
    return theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  }

  function applyTheme(theme, persist) {
    root.dataset.theme = theme;
    if (themeMeta) {
      themeMeta.content = theme === "dark" ? "#0F1013" : "#FBFBFB";
    }
    if (themeToggle) {
      themeToggle.setAttribute("aria-label", themeLabel(theme));
      themeToggle.setAttribute("title", themeLabel(theme));
    }
    if (persist) {
      try {
        localStorage.setItem("ocremote-theme", theme);
      } catch (e) {}
    }
  }

  if (themeToggle) {
    applyTheme(root.dataset.theme === "dark" ? "dark" : "light", false);
    themeToggle.addEventListener("click", function () {
      applyTheme(root.dataset.theme === "dark" ? "light" : "dark", true);
    });
  }

  if (window.matchMedia) {
    var media = window.matchMedia("(prefers-color-scheme: dark)");
    var onSystemChange = function (event) {
      var stored = null;
      try {
        stored = localStorage.getItem("ocremote-theme");
      } catch (e) {}
      if (stored !== "light" && stored !== "dark") {
        applyTheme(event.matches ? "dark" : "light", false);
      }
    };
    if (media.addEventListener) media.addEventListener("change", onSystemChange);
  }

  /* ----------------------------------------------------------------
     Mobile navigation
     ---------------------------------------------------------------- */

  var body = document.body;
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.querySelector(".nav-links");

  if (toggle && nav) {
    var setOpen = function (open) {
      body.classList.toggle("nav-open", open);
      toggle.setAttribute("aria-expanded", String(open));
    };

    toggle.addEventListener("click", function () {
      setOpen(toggle.getAttribute("aria-expanded") !== "true");
    });

    nav.addEventListener("click", function (event) {
      if (event.target.closest("a")) setOpen(false);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && body.classList.contains("nav-open")) {
        setOpen(false);
        toggle.focus();
      }
    });

    document.addEventListener("click", function (event) {
      if (
        body.classList.contains("nav-open") &&
        !event.target.closest(".site-nav")
      ) {
        setOpen(false);
      }
    });
  }

  /* ----------------------------------------------------------------
     Copy buttons
     ---------------------------------------------------------------- */

  document.querySelectorAll(".copy").forEach(function (button) {
    button.addEventListener("click", async function () {
      var id = button.getAttribute("data-copy-target");
      var block = id
        ? document.getElementById(id)
        : button.closest(".code-block") &&
          button.closest(".code-block").querySelector("pre");
      if (!block) return;
      var text = block.textContent || "";
      var label = button.textContent;
      var copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (e) {
        var area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        try {
          copied = document.execCommand("copy");
        } catch (err) {}
        document.body.removeChild(area);
      }
      if (!copied) return;
      button.textContent = button.dataset.copied || (zh ? "已复制" : "Copied");
      window.setTimeout(function () {
        button.textContent = label;
      }, 1600);
    });
  });

  /* ----------------------------------------------------------------
     Reveal on scroll
     ---------------------------------------------------------------- */

  if (!document.querySelector(".hero")) {
    document
      .querySelectorAll(".step, .faq-group, .table-wrap, .diagram-panel, .diagram")
      .forEach(function (element, index) {
        element.setAttribute("data-reveal", "");
        element.style.setProperty("--d", (index % 3) * 70 + "ms");
      });
  }

  var revealItems = document.querySelectorAll("[data-reveal]");

  if (!("IntersectionObserver" in window) || reduceMotion) {
    revealItems.forEach(function (item) {
      item.classList.add("is-in");
    });
  } else {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
    );
    revealItems.forEach(function (item) {
      observer.observe(item);
    });
  }

  /* ----------------------------------------------------------------
     Scroll progress
     ---------------------------------------------------------------- */

  var bar = document.createElement("div");
  bar.className = "scroll-progress";
  bar.setAttribute("aria-hidden", "true");
  body.prepend(bar);

  var ticking = false;
  function paintProgress() {
    var max = document.documentElement.scrollHeight - window.innerHeight;
    var ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    bar.style.width = (ratio * 100).toFixed(2) + "%";
    ticking = false;
  }
  function requestProgress() {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(paintProgress);
    }
  }
  window.addEventListener("scroll", requestProgress, { passive: true });
  window.addEventListener("resize", requestProgress);
  paintProgress();

  /* ----------------------------------------------------------------
     Screenshot rail
     ---------------------------------------------------------------- */

  document.querySelectorAll("[data-rail]").forEach(function (rail) {
    var scope = rail.closest("section") || document;
    var prev = scope.querySelector("[data-rail-prev]");
    var next = scope.querySelector("[data-rail-next]");
    var fill = scope.querySelector("[data-rail-progress]");

    function step(direction) {
      var shot = rail.querySelector(".shot");
      var gap = parseFloat(getComputedStyle(rail).columnGap) || 18;
      var amount = shot
        ? shot.getBoundingClientRect().width + gap
        : Math.max(280, rail.clientWidth * 0.6);
      rail.scrollBy({
        left: direction * amount,
        behavior: reduceMotion ? "auto" : "smooth",
      });
    }

    function update() {
      var max = rail.scrollWidth - rail.clientWidth;
      var ratio = max > 0 ? rail.scrollLeft / max : 1;
      if (fill) fill.style.width = (ratio * 100).toFixed(1) + "%";
      if (prev) prev.disabled = rail.scrollLeft <= 2;
      if (next) next.disabled = rail.scrollLeft >= max - 2;
    }

    if (prev)
      prev.addEventListener("click", function () {
        step(-1);
      });
    if (next)
      next.addEventListener("click", function () {
        step(1);
      });

    rail.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();

    if (window.PointerEvent) {
      var dragging = false;
      var moved = false;
      var suppressClick = false;
      var startX = 0;
      var startLeft = 0;
      var pointerId = null;

      rail.addEventListener("pointerdown", function (event) {
        // Touch already scrolls natively; only add mouse/pen dragging.
        if (event.pointerType === "touch") return;
        if (event.button !== 0) return;
        dragging = true;
        moved = false;
        startX = event.clientX;
        startLeft = rail.scrollLeft;
        pointerId = event.pointerId;
        rail.classList.add("dragging");
      });

      rail.addEventListener("pointermove", function (event) {
        if (!dragging || event.pointerId !== pointerId) return;
        var delta = event.clientX - startX;
        if (!moved && Math.abs(delta) < 6) return;
        if (!moved) {
          moved = true;
          event.preventDefault();
          if (rail.setPointerCapture) {
            try {
              rail.setPointerCapture(pointerId);
            } catch (e) {}
          }
        }
        rail.scrollLeft = startLeft - delta;
      });

      function endDrag(event) {
        if (!dragging) return;
        if (event && event.pointerId !== pointerId) return;
        dragging = false;
        rail.classList.remove("dragging");
        if (moved) {
          suppressClick = true;
          window.setTimeout(function () {
            suppressClick = false;
          }, 0);
        }
        pointerId = null;
      }

      rail.addEventListener("pointerup", endDrag);
      rail.addEventListener("pointercancel", endDrag);
      window.addEventListener("blur", endDrag);

      rail.addEventListener(
        "click",
        function (event) {
          if (suppressClick) {
            event.preventDefault();
            event.stopPropagation();
            suppressClick = false;
          }
        },
        true
      );
    }
  });

  /* ----------------------------------------------------------------
     Lightbox
     ---------------------------------------------------------------- */

  var lightbox = document.querySelector("[data-lightbox]");
  var lightboxImg = lightbox && lightbox.querySelector("[data-lightbox-img]");
  var lightboxCap = lightbox && lightbox.querySelector("[data-lightbox-cap]");
  var lightboxClose =
    lightbox && lightbox.querySelector("[data-lightbox-close]");
  var lastFocus = null;
  var savedScrollY = 0;

  function focusWithoutScroll(element) {
    if (!element || !element.focus) return;
    try {
      element.focus({ preventScroll: true });
    } catch (e) {
      element.focus();
    }
  }

  function closeLightbox() {
    if (!lightbox || lightbox.hidden) return;
    lightbox.hidden = true;
    body.classList.remove("lightbox-open");
    // Keep the gallery and the page exactly where they were before opening.
    var rootStyle = document.documentElement.style;
    var previousBehavior = rootStyle.scrollBehavior;
    rootStyle.scrollBehavior = "auto";
    window.scrollTo(0, savedScrollY);
    rootStyle.scrollBehavior = previousBehavior;
    focusWithoutScroll(lastFocus);
  }

  if (lightbox && lightboxImg) {
    document.querySelectorAll(".shot").forEach(function (shot) {
      shot.addEventListener("click", function () {
        var image = shot.querySelector("img");
        if (!image) return;
        lightboxImg.src = shot.getAttribute("data-full") || image.src;
        lightboxImg.alt = image.alt || "";
        if (lightboxCap) {
          lightboxCap.textContent = shot.getAttribute("data-caption") || "";
        }
        savedScrollY = window.scrollY;
        lastFocus = shot;
        lightbox.hidden = false;
        body.classList.add("lightbox-open");
        focusWithoutScroll(lightboxClose);
      });
    });

    if (lightboxClose) lightboxClose.addEventListener("click", closeLightbox);
    lightbox.addEventListener("click", function (event) {
      if (event.target === lightbox) closeLightbox();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeLightbox();
    });
  }
})();
