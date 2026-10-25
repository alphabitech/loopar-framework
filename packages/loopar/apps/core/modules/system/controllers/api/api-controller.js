'use strict'

import { loopar, fileManage, BaseController } from "loopar";

/** Session key with the review ids this visitor already voted on. */
const VOTED_KEY = 'review_votes';
const clampInt = (v, def, min, max) => {
  const n = parseInt(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};

export default class ApiController extends BaseController {
  async publicActionList() {

    const { app, page_id, limit = 6, offset = 0 } = this.query;
 
    const filter = { approved: 1 };
    if (app)     filter.app     = app;
    if (page_id) filter.page_id = page_id;
 
    const reviews = await loopar.db.getList("Review", {
      filter,
      fields:   ["name", "author_name", "city", "rating", "comment", "creation", "helpful", "not_helpful"],
      orderBy:  "creation desc",
      limit:    clampInt(limit, 6, 1, 50),
      offset:   clampInt(offset, 0, 0, 1_000_000),
    });
 
    return reviews
  }

  async publicActionSubmit() {
    const { author_name, city, rating, comment, app, page_id } = this.body;
 
    if (!author_name?.trim()) return this.error("Author name is required.");
    if (!comment?.trim())     return this.error("Comment is required.");
    if (rating < 1 || rating > 5) return this.error("Rating must be between 1 and 5.");
 
    const doc = await loopar.newDocument("Review", {
      name:        loopar.utils.randomString(15),
      author_name: author_name.trim(),
      city:        (await detectCity(this.req)).city,
      rating:      parseInt(rating),
      comment:     comment.trim(),
      app:         app || "",
      page_id:     page_id || "",
      approved:    0,
      helpful:     0,
      not_helpful: 0,
    });
 
    await doc.save();
 
    return this.success("Review submitted. It will appear once approved.");
  }
 
  async publicActionVote() {
    const { review_id, vote } = this.body;
 
    if (!review_id)                              return this.error("review_id is required.");
    if (!["helpful", "not_helpful"].includes(vote)) return this.error("Invalid vote type.");
 
    // getDoc() filters by `name` only (the `approved` condition was silently
    // dropped → unapproved reviews could be voted): query with both.
    const review = await loopar.db.query("Review")
      .where({ name: String(review_id), approved: 1 })
      .first("name");

    if (!review) return this.error("Review not found.");

    // One vote per review per visitor session (no anonymous vote stuffing).
    const voted = loopar.session.get(VOTED_KEY) || [];
    if (voted.includes(review.name)) return this.error("You already voted on this review.");

    // Atomic increment (read-then-write lost concurrent votes). `vote` is
    // whitelisted above, so it is safe as a column name.
    await loopar.db.query("Review").where({ name: review.name }).increment(vote, 1);
    loopar.session.set(VOTED_KEY, [...voted, review.name].slice(-500));

    return this.success("Vote registered.");
  }
}