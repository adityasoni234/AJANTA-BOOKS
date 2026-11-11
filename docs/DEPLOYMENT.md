# Deployment, operations, backups

## Topology

```
Browser ──HTTPS──▶ Firebase Hosting (static app)          project ajantabooks-840e7
   │
   ├──▶ Firebase Auth (email + password)
   └──▶ Cloud Firestore (all data; protected by firestore.rules)
```

There is no application server. The app's business logic runs in the browser (`frontend/src/server`), and
Firestore security rules decide what each signed-in user may read and write.

## Deploying

Prerequisites: Firebase CLI signed in to the account that owns the project (`firebase login`), and
`frontend/.env.local` containing the Firebase web config and `SETUP_EMAIL`.

```bash
cd frontend && npm run build && cd ..
firebase deploy --only hosting,firestore --project ajantabooks-840e7
```

* `hosting` publishes `frontend/dist`.
* `firestore` publishes the rules and indexes. The predeploy step renders `firestore.rules` from
  `firestore.rules.template`, filling in `SETUP_EMAIL` (the only email allowed to run first-time setup).
  The rendered file is gitignored.
* New composite indexes can take a few minutes to build; until then, store-level (non-owner) users may see an
  index error on the affected screen.

## First run

The first person to open the site sees **First-time setup**. Setup only succeeds for `SETUP_EMAIL`, and only
once (the rules allow `meta/setup` to be created a single time). That person becomes the owner with every
permission and access to all locations. Staff logins are created afterwards under Administration → Users.

## Required Firebase settings

* **Authentication → Sign-in method:** Email/Password enabled.
* **Firestore:** native mode database `(default)`. Its location can't be changed later.
* Optional: Authentication → Settings → password policy (the app already requires 10+ characters with three
  character classes).

## Backups

Firestore on the free Spark plan has no scheduled backups. Options:

* **Blaze plan:** enable scheduled backups or point-in-time recovery in the Firestore console (recommended for
  real business data).
* **Spark plan:** export reports/CSVs regularly (catalog export, GST register, trial balance) and keep them safe.

## Quotas (Spark plan)

50,000 document reads, 20,000 writes and 20,000 deletes per day; 1 GiB stored. The app keeps reads low (catalog
and stock are stored in packed documents; reports read daily/monthly summaries), but heavy use can still reach the
limit. When a quota is exceeded the app shows "Daily free usage limit reached"; upgrading to Blaze removes the
hard limit (pay per use).

## Local development

`cd frontend && npm run dev` starts the Auth and Firestore emulators (data is local and disposable) together with
the app on <http://localhost:5199>. Requires Java 11+ and the Firebase CLI.
