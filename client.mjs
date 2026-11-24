const topicLabels = { delivery: "Доставка", pricing: "Стоимость", other: "Другое" };
const manualMessage = "Нужен ручной разбор: не удалось подготовить ответ. Выберите тему и составьте ответ самостоятельно. Текст заявки сохранён выше.";

export function attachTriageForm(root, fetchReply = globalThis.fetch) {
  const form = root.querySelector("form");
  const message = root.querySelector("#message");
  const status = root.querySelector("#status");
  const topic = root.querySelector("#topic");
  const draft = root.querySelector("#draft");
  let latestRequest = 0;
  let activeController;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const requestId = ++latestRequest;
    activeController?.abort();
    topic.textContent = "";
    draft.textContent = "";
    const text = message.value.trim();
    if (!text) {
      status.textContent = "Введите текст заявки.";
      return;
    }
    activeController = new AbortController();
    const controller = activeController;
    // A separate browser deadline covers network failures as well as API delays.
    const timer = setTimeout(() => controller.abort(), 5000);
    status.textContent = "Разбираем заявку…";
    try {
      const reply = await fetchReply("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      const result = await reply.json();
      if (requestId !== latestRequest) return;
      if (reply.status === 400 && result?.status === "invalid_input") {
        status.textContent = "Введите непустой текст заявки.";
        return;
      }
      if (!reply.ok || result?.status !== "ready" ||
          !Object.hasOwn(topicLabels, result.topic) ||
          typeof result.draft !== "string" || !result.draft.trim()) {
        throw new Error("Manual review required");
      }
      topic.textContent = topicLabels[result.topic];
      draft.textContent = result.draft.trim();
      status.textContent = "Черновик готов. Проверьте его перед отправкой клиенту.";
    } catch {
      if (requestId !== latestRequest) return;
      topic.textContent = "";
      draft.textContent = "";
      status.textContent = manualMessage;
    } finally {
      clearTimeout(timer);
    }
  });
}

if (typeof document !== "undefined") attachTriageForm(document);
