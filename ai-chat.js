(() => {
  const launcher = document.getElementById('aiChatLauncher');
  const panel = document.getElementById('aiChatPanel');
  const closeButton = document.getElementById('aiChatClose');
  const form = document.getElementById('aiChatForm');
  const input = document.getElementById('aiChatInput');
  const sendButton = document.getElementById('aiChatSend');
  const messagesNode = document.getElementById('aiChatMessages');
  const statusNode = document.getElementById('aiChatStatus');
  const history = [];

  function appendMessage(role, text) {
    const message = document.createElement('div');
    message.className = `ai-chat-message ${role}`;
    message.textContent = text;
    messagesNode.append(message);
    messagesNode.scrollTop = messagesNode.scrollHeight;
  }

  function setOpen(isOpen) {
    panel.classList.toggle('is-open', isOpen);
    launcher.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) input.focus();
    else launcher.focus();
  }

  launcher.addEventListener('click', () => setOpen(!panel.classList.contains('is-open')));
  closeButton.addEventListener('click', () => setOpen(false));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || sendButton.disabled) return;

    appendMessage('user', text);
    history.push({ role: 'user', content: text });
    if (history.length > 8) history.splice(0, 2);
    input.value = '';
    input.disabled = true;
    sendButton.disabled = true;
    statusNode.textContent = 'Jawab taiyar ho raha hai…';

    try {
      const response = await fetch('/api/ai-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Abhi jawab nahi mil paya.');
      appendMessage('assistant', result.reply);
      history.push({ role: 'assistant', content: result.reply });
      statusNode.textContent = '';
    } catch (error) {
      history.pop();
      appendMessage('assistant', `${error.message} Madad ke liye 7782826601 par call karein.`);
      statusNode.textContent = '';
    } finally {
      input.disabled = false;
      sendButton.disabled = false;
      input.focus();
    }
  });
})();
