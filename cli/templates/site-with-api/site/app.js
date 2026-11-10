// The guestbook's page: it reads its API's address from config.json, written beside it for each place it runs
// ({"api": "<the API's URL>"}), lists the latest entries and sends new ones there. The API's URL lets any page call it,
// as its CORS in template.yaml says.
const said = document.getElementById('said');
const list = document.getElementById('entries');

const api = fetch('config.json', { cache: 'no-cache' })
  .then((response) => {
    if (!response.ok) throw new Error('config.json is missing: README.md says how to write it');
    return response.json();
  })
  .then((config) => config.api.replace(/\/$/, ''));

async function show() {
  const response = await fetch(`${await api}/entries`);
  if (!response.ok) throw new Error(`the API answered ${response.status}`);
  const entries = await response.json();
  list.replaceChildren(
    ...entries.map((entry) => {
      const item = document.createElement('li');
      const who = document.createElement('strong');
      who.textContent = entry.name;
      const when = document.createElement('time');
      when.dateTime = entry.at;
      when.textContent = new Date(entry.at).toLocaleString();
      const message = document.createElement('p');
      message.textContent = entry.message;
      item.append(who, ' ', when, message);
      return item;
    }),
  );
}

document.getElementById('sign').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const entry = { name: form.get('name'), message: form.get('message') };
  try {
    const response = await fetch(`${await api}/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entry),
    });
    const kept = await response.json();
    if (!response.ok) throw new Error(kept.message ?? `the API answered ${response.status}`);
    said.textContent = `Thank you, ${kept.name}.`;
    event.target.reset();
    await show();
  } catch (error) {
    said.textContent = `The entry wasn't kept: ${error.message}`;
  }
});

show().catch((error) => {
  said.textContent = `The entries couldn't be read: ${error.message}`;
});
