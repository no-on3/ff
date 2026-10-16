# FF dashboard

The web console for FF: list, create, edit, and invoke functions, and view their metrics. It is a React app built with Vite, and it uses Redux Toolkit, MUI, and Tailwind.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check, then a production build in dist/
```

It calls the backend API at `http://localhost:3000`, which is hard-coded in `src/services/api.ts`. Start the backend first: see [Getting started](../docs/getting-started.md).

Known gaps (parent plan F-10):
- the invocation history is read as a list, but the API returns `{invocations, total}`, so past invocations don't show;
- a fresh invocation is added without its duration or memory, which are read from a `metrics` object the API doesn't return;
- saving the scaling configuration calls `PUT /functions/:id/scaling-config`, which the API does not have;
- there is no login yet;
- two UI kits (MUI and Tailwind) are used side by side.
