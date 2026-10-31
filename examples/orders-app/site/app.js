// The small app's page: it reads its API's address from config.json, which the deploy writes beside it
// ({"api": "<orders-api's URL>"}), lists the latest orders and sends new ones there. The function URL's CORS lets this
// site's origin in.
const said = document.getElementById('said');
const list = document.getElementById('orders');

const api = fetch('/config.json', { cache: 'no-cache' })
  .then((response) => (response.ok ? response.json() : Promise.reject(new Error('config.json is missing: write it at deploy'))))
  .then((config) => config.api.replace(/\/$/, ''));

async function show() {
  const response = await fetch(`${await api}/orders`);
  if (!response.ok) throw new Error(`the API answered ${response.status}`);
  const rows = await response.json();
  list.replaceChildren(
    ...rows.map((order) => {
      const row = document.createElement('tr');
      for (const value of [order.id, order.item, order.quantity, new Date(order.created_at).toLocaleString()]) {
        const cell = document.createElement('td');
        cell.textContent = String(value);
        row.append(cell);
      }
      return row;
    }),
  );
}

document.getElementById('order').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const order = { item: form.get('item'), quantity: Number(form.get('quantity')) };
  if (form.get('email')) order.email = form.get('email');
  try {
    const response = await fetch(`${await api}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(order) });
    const made = await response.json();
    if (!response.ok) throw new Error(made.message ?? `the API answered ${response.status}`);
    said.textContent = `Order ${made.id} taken${order.email ? ': its receipt goes to ' + order.email : ''}.`;
    event.target.reset();
    await show();
  } catch (error) {
    said.textContent = `The order wasn't taken: ${error.message}`;
  }
});

show().catch((error) => {
  said.textContent = `The orders couldn't be read: ${error.message}`;
});
