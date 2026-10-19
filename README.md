# EDP Books

A private bookkeeping website for Exterior Design Plus LLC: bank and card lines,
categories, business and personal, money per job, contractor totals, and red flags.

This repository holds only the website's code. No financial records are stored here.
All records live in a Supabase database. Every table is locked with row level
security, so only the owner's login can read or change anything. The key in
`config.js` is Supabase's publishable key, which is public by design.

- `index.html`, `app.js`, `app.css`: the website (no build step)
- `setup.sql`: database tables, views and locks
- `vendor/supabase-2.117.2.js`: Supabase's JavaScript library (MIT license, see `vendor/supabase-LICENSE.txt`)
