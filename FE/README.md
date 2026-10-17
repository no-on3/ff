# FF dashboard

The web console for FF: list, create, edit, and invoke functions, change their instance limits, and view their metrics. It is a React app built with Vite, and it uses Redux Toolkit, MUI, and Tailwind.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check, then a production build in dist/
npm test           # unit tests (Vitest)
npm run lint
```

It calls the backend API at `http://localhost:3000`, which is hard-coded in `src/services/api.ts` until P-14 of the [client-readiness plan](../docs/client-readiness-plan.md). Start the backend first: see [Getting started](../docs/getting-started.md).

`dependencies` lists exactly what ships in the bundle, so `npm audit --omit=dev` audits what users get; the build and test tools are `devDependencies`.

Known gaps, each with its task in the client-readiness plan:
- there is no login yet, and the layout is narrow (P-14);
- the metrics page reads an API that P-50 replaces, and has the two lint errors left;
- two UI kits (MUI and Tailwind) are used side by side.
