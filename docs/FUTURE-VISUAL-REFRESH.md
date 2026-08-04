# Future Visual Refresh Notes

Do not implement this until explicitly requested. These notes capture a possible future design direction inspired by the visual language of Aktus Praxis and Treadwell Terminal, without copying their proprietary assets, text, or exact CSS.

## Direction

- Use a premium public-data palette: deep navy surfaces, white/off-white panels, slate body text, and restrained cyan accents for active states and primary actions.
- Pair a refined serif display face for the product title with a clean sans-serif body face. A candidate pairing is Playfair Display for the title and DM Sans for interface text.
- Keep the application-first layout. This is an operational map/search tool, not a marketing page, so avoid large hero sections or decorative landing-page composition.
- Make navigation and command labels compact and confident: small uppercase labels, thin borders, subtle hover fills, and clear pressed states.
- Preserve existing table density and map workspace behavior. Any refresh should change visual treatment, not core workflows.

## Candidate Touch Points

- `web/index.html`: update the Google Fonts link if changing the type system.
- `web/src/lib/tailwind.css`: update shared design tokens for primary, accent, neutral, and font families.
- `web/src/style.css`: update the late visual-refresh override layer so older rules remain undisturbed.

## Components To Consider

- Topbar: deep navy background, subtle cyan border/glow, serif title treatment, compact uppercase links.
- Buttons: navy-filled primary buttons, outlined secondary buttons, cyan hover/focus states, 6px or smaller radii.
- Sidebar: white or near-white panel surface, cool slate borders, slightly more polished tab and disclosure states.
- Tables: light blue-grey header rows, cyan hover/group highlights, existing compact row density retained.
- Map controls/popovers: align border radius, shadows, and focus states with the rest of the interface.

## Guardrails

- Do not copy logos, text, images, videos, or exact CSS from reference sites.
- Avoid turning the tool into a landing page.
- Keep accessibility and keyboard focus states visible.
- Run `npm run build` and `npm test` after any future implementation.
