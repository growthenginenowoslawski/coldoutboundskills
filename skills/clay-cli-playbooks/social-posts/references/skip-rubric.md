# The screening rubric (you apply it; no model call is made)

You are the screener. For each fetched post, newest first, assign exactly one category. Stop at the
first post that is `business` and keep it. Every other category means take the next post.

| Category | What it covers | Keep? |
|---|---|---|
| `business` | product news, hiring, customers, partnerships, funding, events, research, industry opinion, marketing, work jokes, memes, polls, job ads, corporate volunteering, work anniversaries and promotions posted by a company, commentary on business regulation | **keep** |
| `personal` | the author's private life: family, marriage, birth, illness, grief, a personal milestone or struggle, a tribute to a friend or relative, a post the author frames as personal | skip |
| `political` | elections, candidates, parties, advocacy framed legislation, protests, praise or attack of a politician or government as a political position, any call to political action | skip |
| `bereavement` | a death, funeral, memorial, condolence, "in memory of", a passing announcement | skip |
| `charged` | wars and armed conflict, national or ethnic conflict, religious observance or advocacy, and religious or geopolitical flashpoints anywhere | skip |

Tie-breaks, in order:

1. Grief and death beat any business framing. A company post announcing its founder died is
   `bereavement`.
2. A company wishing customers a happy holiday is `business`. One passing mention of a place or a holiday
   does not make a business post `charged`.
3. Charity and fundraising are `business` unless tied to a political, armed-conflict or religious cause.
4. When a post could reasonably be read either way, choose the skip category. A skipped post costs the
   next post in the list; a sent one costs the relationship.
5. Judge only the text in `content`. Never infer from an image you cannot see or a link you did not
   open; a post whose text is empty or only a link is `unreadable` and is skipped.

Record for every post you screened: its permalink, the category, and a reason of five words or fewer.
The installer sees these in the delivery, so a skip is auditable rather than silent.

## What the rubric was measured against

The GEX build this skill is ported from ran the same five categories as a model prompt on 2026-08-07
against a labelled set of 18 posts (four skip categories plus six deliberately near-boundary business
posts) and scored 18/18. On 2026-09-23 the rubric was applied by hand to the 18 posts the batch
returned; all 18 were `business`, including a work-meme post, which is the boundary case the rubric keeps.
