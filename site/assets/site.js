(function () {
  const body = document.body;
  const toggle = document.querySelector(".nav-toggle");
  const nav = document.querySelector(".nav-links");

  if (toggle && nav) {
    const setOpen = (open) => {
      body.classList.toggle("nav-open", open);
      toggle.setAttribute("aria-expanded", String(open));
    };

    toggle.addEventListener("click", () => {
      setOpen(toggle.getAttribute("aria-expanded") !== "true");
    });

    nav.addEventListener("click", (event) => {
      if (event.target.closest("a")) setOpen(false);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && body.classList.contains("nav-open")) {
        setOpen(false);
        toggle.focus();
      }
    });

    document.addEventListener("click", (event) => {
      if (body.classList.contains("nav-open") && !event.target.closest(".site-nav")) {
        setOpen(false);
      }
    });
  }

  document.querySelectorAll(".copy").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.getAttribute("data-copy-target");
      const block = id ? document.getElementById(id) : button.closest(".code-block")?.querySelector("pre");
      if (!block) return;
      const text = block.textContent ?? "";
      const label = button.textContent;
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = button.dataset.copied ?? (document.documentElement.lang.startsWith("zh") ? "已复制" : "Copied");
        window.setTimeout(() => {
          button.textContent = label;
        }, 1600);
      } catch {
        button.textContent = label;
      }
    });
  });
})();
