/**
 * WorkBuddy Connect Frontend Entry
 * Single-file pure ESM plugin without build tools or relative imports.
 */

// Inject styles for the statusbar widget and settings detail card
const PLUGIN_STYLES = `
.wb-statusbar-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  user-select: none;
  transition: background-color 0.15s ease;
}
.wb-statusbar-item:hover {
  background-color: rgba(128, 128, 128, 0.15);
}
.wb-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
  background-color: #94a3b8;
  transition: background-color 0.2s ease, box-shadow 0.2s ease;
}
.wb-status-dot.running {
  background-color: #22c55e;
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.5);
}
.wb-status-dot.starting {
  background-color: #eab308;
  box-shadow: 0 0 6px rgba(234, 179, 8, 0.5);
}
.wb-status-dot.crashed,
.wb-status-dot.unhealthy,
.wb-status-dot.setup_failed {
  background-color: #ef4444;
  box-shadow: 0 0 6px rgba(239, 68, 68, 0.5);
}
.wb-status-dot.stopped {
  background-color: #94a3b8;
}

.wb-detail-container {
  margin-top: 16px;
  padding: 16px;
  border-radius: 8px;
  border: 1px solid rgba(128, 128, 128, 0.2);
  background: rgba(128, 128, 128, 0.04);
  font-family: inherit;
}
.wb-detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.wb-detail-title {
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
.wb-detail-btn {
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid rgba(128, 128, 128, 0.3);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.wb-detail-btn:hover {
  background: rgba(128, 128, 128, 0.12);
}
.wb-probe-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  background-color: rgba(234, 179, 8, 0.1);
  border: 1px solid rgba(234, 179, 8, 0.3);
  color: #ca8a04;
  font-size: 12px;
}
.wb-models-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wb-model-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.08);
  font-size: 13px;
}
.wb-model-id {
  font-family: monospace;
  font-weight: 500;
}
.wb-model-badges {
  display: flex;
  gap: 6px;
  align-items: center;
}
.wb-badge {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
}
.wb-badge-free {
  background: rgba(34, 197, 94, 0.15);
  color: #16a34a;
  border: 1px solid rgba(34, 197, 94, 0.3);
}
.wb-badge-promo {
  background: rgba(59, 130, 246, 0.15);
  color: #2563eb;
  border: 1px solid rgba(59, 130, 246, 0.3);
}
.wb-detail-loading,
.wb-detail-error,
.wb-detail-empty {
  padding: 16px;
  text-align: center;
  font-size: 13px;
  color: rgba(128, 128, 128, 0.9);
}
.wb-detail-error {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.05);
  border-radius: 6px;
}
`;

function getStatusLabel(state) {
  switch (state) {
    case "running":
      return "运行中 (Running)";
    case "starting":
      return "启动中 (Starting)";
    case "crashed":
      return "已崩溃 (Crashed)";
    case "unhealthy":
      return "不健康 (Unhealthy)";
    case "setup_failed":
      return "初始化失败 (Setup Failed)";
    case "stopped":
    default:
      return "已停止 (Stopped)";
  }
}

let activeDisposers = [];

export function activate(ctx) {
  // Inject plugin styles if injectCSS is available
  if (typeof ctx.injectCSS === "function") {
    ctx.injectCSS(PLUGIN_STYLES);
  }

  // 1. Statusbar Right Slot Contribution
  ctx.registerSlot("statusbar.right", {
    id: "workbuddy-status",
    order: 100,
    mount(el) {
      let mounted = true;
      let currentStatus = null;

      const container = document.createElement("div");
      container.className = "wb-statusbar-item";
      container.setAttribute("role", "button");
      container.setAttribute("tabindex", "0");

      const dot = document.createElement("span");
      dot.className = "wb-status-dot stopped";

      const text = document.createElement("span");
      text.className = "wb-status-text";
      text.textContent = "WorkBuddy";

      container.appendChild(dot);
      container.appendChild(text);
      el.appendChild(container);

      const renderStatus = (status) => {
        if (!mounted) return;
        currentStatus = status || { state: "stopped" };
        const state = currentStatus.state || "stopped";
        dot.className = "wb-status-dot " + state;
        const label = getStatusLabel(state);
        const titleText = "WorkBuddy: " + label + (currentStatus.port ? " (" + currentStatus.port + ")" : "");
        container.setAttribute("title", titleText);
        container.setAttribute("aria-label", titleText);
      };

      const onClick = () => {
        const state = currentStatus ? currentStatus.state : "stopped";
        const label = getStatusLabel(state);
        let msg = "WorkBuddy 状态: " + label;
        if (currentStatus && currentStatus.port) {
          msg += " | 端口: " + currentStatus.port;
        }
        if (currentStatus && currentStatus.pid) {
          msg += " | PID: " + currentStatus.pid;
        }
        if (currentStatus && currentStatus.lastError) {
          msg += "\n错误: " + currentStatus.lastError;
        }

        const notifyType = state === "running" ? "success" : state === "starting" ? "info" : "warning";
        if (typeof ctx.notify === "function") {
          ctx.notify(msg, notifyType);
        }
      };

      container.addEventListener("click", onClick);

      // Fetch initial status
      if (ctx.backend && typeof ctx.backend.status === "function") {
        ctx.backend.status().then((st) => {
          if (mounted) renderStatus(st);
        }).catch(() => {
          if (mounted) renderStatus({ state: "stopped" });
        });
      }

      // Listen for status changes
      if (ctx.backend && typeof ctx.backend.onStatus === "function") {
        ctx.backend.onStatus((st) => {
          if (mounted) renderStatus(st);
        });
      }

      // Return cleanup function to guarantee 0 DOM leakage
      return () => {
        mounted = false;
        container.removeEventListener("click", onClick);
        if (container.parentNode === el) {
          el.removeChild(container);
        }
        el.innerHTML = "";
      };
    },
  });

  // 2. Settings Plugin Detail Slot Contribution
  ctx.registerSlot("settings.plugin-detail", {
    id: "workbuddy-detail",
    order: 10,
    mount(el) {
      let mounted = true;

      const container = document.createElement("div");
      container.className = "wb-detail-container";

      // Header
      const header = document.createElement("div");
      header.className = "wb-detail-header";

      const title = document.createElement("div");
      title.className = "wb-detail-title";
      title.textContent = "WorkBuddy 本机模型服务";

      const refreshBtn = document.createElement("button");
      refreshBtn.className = "wb-detail-btn";
      refreshBtn.textContent = "刷新模型";

      header.appendChild(title);
      header.appendChild(refreshBtn);
      container.appendChild(header);

      // Probe banner (conditionally rendered)
      const probeBanner = document.createElement("div");
      probeBanner.className = "wb-probe-banner";
      probeBanner.textContent = "⚡ 已允许探测推理档位（注意：探测可能会消耗少量额度）";
      probeBanner.style.display = "none";
      container.appendChild(probeBanner);

      // Content Area for models
      const content = document.createElement("div");
      content.className = "wb-detail-content";
      container.appendChild(content);

      el.appendChild(container);

      const updateProbeBanner = (consent) => {
        if (!mounted) return;
        probeBanner.style.display = (consent === true || consent === "true") ? "flex" : "none";
      };

      // Read initial config
      if (ctx.config && typeof ctx.config.get === "function") {
        ctx.config.get().then((cfg) => {
          if (mounted && cfg) {
            updateProbeBanner(cfg.probeConsent);
          }
        }).catch(() => {});
      }

      // Listen for config changes
      if (ctx.config && typeof ctx.config.onChange === "function") {
        ctx.config.onChange((cfg) => {
          if (mounted && cfg) {
            updateProbeBanner(cfg.probeConsent);
          }
        });
      }

      const loadModels = () => {
        if (!mounted) return;
        content.innerHTML = '<div class="wb-detail-loading">正在获取已连接模型列表...</div>';

        if (!ctx.backend || typeof ctx.backend.fetch !== "function") {
          content.innerHTML = '<div class="wb-detail-error">插件后端服务未就绪</div>';
          return;
        }

        ctx.backend.fetch("/v1/models")
          .then((res) => {
            if (!mounted) return;
            if (res.status !== 200) {
              content.innerHTML = '<div class="wb-detail-error">获取模型列表失败 (HTTP ' + res.status + '): ' + (res.body || "服务异常") + '</div>';
              return;
            }

            let data;
            try {
              data = JSON.parse(res.body);
            } catch (e) {
              content.innerHTML = '<div class="wb-detail-error">响应解析失败: ' + e.message + '</div>';
              return;
            }

            const models = (data && data.data) || [];
            if (models.length === 0) {
              content.innerHTML = '<div class="wb-detail-empty">未发现可用模型，请确认 WorkBuddy 桌面端已登录并启动</div>';
              return;
            }

            const list = document.createElement("div");
            list.className = "wb-models-list";

            models.forEach((m) => {
              const card = document.createElement("div");
              card.className = "wb-model-card";

              const idSpan = document.createElement("span");
              idSpan.className = "wb-model-id";
              idSpan.textContent = m.name || m.id;

              const badgesDiv = document.createElement("div");
              badgesDiv.className = "wb-model-badges";

              if (m.credits) {
                const creditBadge = document.createElement("span");
                creditBadge.className = "wb-badge wb-badge-free";
                creditBadge.textContent = m.credits;
                badgesDiv.appendChild(creditBadge);
              }

              if (Array.isArray(m.badges)) {
                m.badges.forEach((b) => {
                  const promoBadge = document.createElement("span");
                  promoBadge.className = "wb-badge wb-badge-promo";
                  promoBadge.textContent = b;
                  badgesDiv.appendChild(promoBadge);
                });
              }

              card.appendChild(idSpan);
              card.appendChild(badgesDiv);
              list.appendChild(card);
            });

            content.innerHTML = "";
            content.appendChild(list);
          })
          .catch((err) => {
            if (!mounted) return;
            content.innerHTML = '<div class="wb-detail-error">网络请求失败: ' + (err.message || String(err)) + '</div>';
          });
      };

      refreshBtn.addEventListener("click", loadModels);

      // Initial models fetch
      loadModels();

      // Return cleanup function to guarantee 0 DOM leakage
      return () => {
        mounted = false;
        refreshBtn.removeEventListener("click", loadModels);
        if (container.parentNode === el) {
          el.removeChild(container);
        }
        el.innerHTML = "";
      };
    },
  });

  // Track disposal
  const disposeHandler = () => {
    // any plugin-wide cleanup
  };
  activeDisposers.push(disposeHandler);

  if (typeof ctx.onDispose === "function") {
    ctx.onDispose(disposeHandler);
  }
}

export function deactivate() {
  for (const d of activeDisposers) {
    try {
      d();
    } catch (_) {}
  }
  activeDisposers = [];
}
