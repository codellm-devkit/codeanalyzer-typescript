# codeanalyzer-typescript — documentation site

This branch holds the documentation site for [**codeanalyzer-typescript**](https://github.com/codellm-devkit/codeanalyzer-typescript), the TypeScript/JavaScript static-analysis backend behind [CLDK](https://github.com/codellm-devkit/python-sdk). The tool's source code lives on `main`; this `docs` branch is the [Astro](https://astro.build/) + [Starlight](https://starlight.astro.build/) site that documents it.

## Develop

```shell
npm install        # install dependencies
npm run dev        # local dev server at http://localhost:4321
npm run build      # production build into ./dist
npm run preview    # preview the production build
```

## Structure

```
src/
  content/
    docs/
      index.mdx                     # landing page (splash)
      what-is-codeanalyzer.mdx
      quickstart.mdx
      installing.mdx
      guides/
        cli-usage.mdx
        concepts.mdx
        call-graph.mdx              # tsc resolver + RTA + phantom nodes
        level-2.mdx                 # CodeQL & entrypoints (experimental)
      reference/
        cli.mdx                     # CLI option reference
        schema.mdx                  # TSApplication output schema
  styles/docs.css                   # theme
  assets/                           # logo
astro.config.mjs                    # site + sidebar config
```

## Internal links (important)

The site is served from a **base path** — `https://codellm-devkit.github.io/codeanalyzer-typescript/` (set via `site` + `base` in `astro.config.mjs`). Astro does **not** rewrite links in page content, so every internal link must include the base prefix:

```md
<!-- correct -->
[Quickstart](/codeanalyzer-typescript/quickstart/)
<LinkCard href="/codeanalyzer-typescript/guides/concepts/" ... />

<!-- WRONG — 404s at the base path -->
[Quickstart](/quickstart/)
```

Sidebar `slug` entries in `astro.config.mjs` and assets are based automatically — only authored links in `.mdx` need the prefix. To verify after editing, build and grep `dist/` for any `href="/…"` that doesn't start with `/codeanalyzer-typescript/`.

## Deploy

Pushing to `docs` triggers `.github/workflows/deploy.yml`, which builds the site and publishes `dist/` to the `gh-pages` branch. GitHub Pages then serves it at `https://codellm-devkit.github.io/codeanalyzer-typescript/`.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
