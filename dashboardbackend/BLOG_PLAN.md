# Blog plan

The blog plan is the list of blogs we want to publish and when. Each week we write it as a JSON file and upload it on
the dashboard's **Blogs** page. The dashboard checks the file, saves it in Supabase and shows which blog goes out on
which day.

Each entry is a **brief**: what the blog is about and how to write it. It is not the blog text. The blog is written
from the brief later (see [What is not automatic yet](#what-is-not-automatic-yet)).

## The JSON file

```json
{
  "blogs": [
    {
      "id": "BLG-001",
      "topic": "AIDL vs HIDL: Writing a modern HAL in AOSP",
      "category": "HAL",
      "keywords": ["AIDL", "HIDL", "Treble"],
      "publish_date": "2026-10-12",
      "tone": "technical, beginner-friendly",
      "length": "1000-1500 words",
      "target_versions": ["Android 15"],
      "reference_urls": ["https://source.android.com/docs/core/architecture/aidl"]
    }
  ]
}
```

| Field             | Required | Rules                                                                                       |
|-------------------|----------|---------------------------------------------------------------------------------------------|
| `id`              | yes      | Unique in the file. Up to 40 letters, digits, `-` or `_`. Uploading the same id again updates that blog. |
| `topic`           | yes      | 10 to 200 characters.                                                                        |
| `category`        | yes      | Usually one of AOSP, HAL, BSP, Embedded, Kernel, Drivers, Security, Tooling (others give a warning). |
| `keywords`        | yes      | 1 to 10 words or phrases.                                                                    |
| `publish_date`    | yes      | `YYYY-MM-DD`, today or later.                                                                |
| `tone`            | no       | Text, up to 100 characters.                                                                  |
| `length`          | no       | Text, up to 100 characters, e.g. `"1000-1500 words"`.                                       |
| `target_versions` | no       | List of texts, e.g. `["Android 15", "Android 16"]`.                                         |
| `reference_urls`  | no       | Up to 10 links, each starting with `http://` or `https://`.                                  |

A file can have up to 60 blogs and be up to 1 MB.

## Uploading (admins only)

1. Open **Blogs** and click **Upload blog plan** at the top of the Blog Plan card.
2. Choose the `.json` file. The dashboard checks it first and saves nothing yet.
3. A preview lists every blog with its date and what will happen to it:
   - **New**: not in the plan yet.
   - **Update**: a blog with this id is already in the plan; its details will be replaced.
   - **Skipped (posted)**: that blog is already posted, so it is never changed.
4. Problems are listed in red with the blog's id and the field, for example `BLG-102 · publish_date: Use a real
   date written as YYYY-MM-DD.` While there are problems, **Import** is disabled: fix the file and upload it again.
   Warnings (in orange, e.g. two blogs on the same day) don't stop the import.
5. Click **Import**. The page shows `Imported: 4 new, 1 updated.` and the schedule refreshes.

Everyone can see the plan; only admins can upload or cancel. The backend checks the admin role in the database on
every upload, so the button being visible is not what allows it.

## What the Blogs page shows

- **Planned blogs**: how many blogs are in the plan (cancelled ones not counted).
- **This week**: how many are planned for the current week (Monday to Sunday).
- **Posted**: how many are posted.
- **Next blog**: the next date and topic.
- **The schedule**, grouped by week ("Week of Oct 12"), one row per blog with its date, topic, category and status:

| Status    | Meaning                                                        |
|-----------|----------------------------------------------------------------|
| Planned   | In the plan, not written yet.                                  |
| Written   | A blog post has been written from it, not posted yet.          |
| Posted    | Its blog is published.                                         |
| Missed    | The date has passed and it isn't posted.                       |
| Cancelled | Taken off the schedule (uploading it again brings it back).    |

Click a row to see the full brief: keywords, tone, length, target versions and reference links. Admins can
**Cancel** a blog that isn't posted yet.

## Where it is stored

Supabase, table **`public.blog_plan`**, one row per blog. The backend creates the table the first time it is used;
`migrations/002_blog_plan.sql` creates the same table if you prefer to run it yourself in the SQL editor.

| Column            | Holds                                                                  |
|-------------------|------------------------------------------------------------------------|
| `id`              | Database id (used in the dashboard's links).                           |
| `external_id`     | The JSON `id`, e.g. `BLG-001`. Unique.                                 |
| `topic`, `category`, `keywords`, `publish_date`, `tone`, `length`, `target_versions`, `reference_urls` | The fields from the file. |
| `status`          | `planned`, `written`, `posted` or `cancelled` (Missed is worked out from the date, not stored). |
| `post_id`         | The blog written from this brief (`content_posts.id`), once there is one. |
| `uploaded_by`     | Email of the admin who last uploaded it.                               |
| `created_at`, `updated_at` | When it was first added and last changed.                     |

To look at it in Supabase: **Table Editor → blog_plan**, or in the **SQL editor**:

```sql
select external_id, publish_date, topic, category, status
from blog_plan
order by publish_date;
```

Row level security is on with no policies, so the browser's Supabase keys can't read or change the table; only the
dashboard backend (its database connection) can.

## Uploading again

- A blog with the same `id` is **updated** (topic, date, keywords and the rest are replaced).
- A blog whose post is already **published** is never changed and shows as Skipped.
- A **cancelled** blog uploaded again goes back to Planned.
- Blogs that are in the database but not in the new file are left as they are. To remove one, cancel it.

## What is not automatic yet

Nothing writes a blog from a brief or publishes it on its date yet. `post_id` and `status` are there so that can be
added. Options:

1. **The agent writes it.** The agent's daily blog (`~/Marketing-AI-Agent/agent/blog.py`) currently picks its own
   topic. It could instead take the next brief due within a few days from `blog_plan`, write the post, save it in
   `content_posts`, and set `post_id` and `status = 'written'`. Then decide whether the agent should stop picking its
   own topics.
2. **A scheduled job on Render** publishes posts whose brief's date has come, then sets `status = 'posted'`.
3. **By hand**: write and post the blog, then link it (set `post_id`) so the dashboard shows it as posted.

## Testing it

Two example files are in `samples/`:

- `samples/blog_plan.sample.json`: 6 valid blogs, two a week (Monday and Thursday) from Oct 12 to Oct 29, 2026.
  Upload it: the preview shows 6 New; after Import the card shows 6 planned blogs. Upload it again: 6 Update.
- `samples/blog_plan.invalid.json`: one mistake per blog (missing topic, impossible date, past date, `ftp://` link,
  duplicate id, empty keywords, unusual category). Upload it to see every problem listed and Import disabled.

The sample dates are fixed. After Oct 29, 2026 they are in the past and the valid file will be refused; change the
dates to test again.

Automated tests: `pytest tests/test_blog_plan.py` (validation with both sample files, import, dry run, admin-only,
cancel, statuses and the summary counts).
