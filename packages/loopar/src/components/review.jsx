import { withRoot } from "./base/with-root.jsx";
import { useState, useEffect } from "react";
import { loopar, useRealtime } from "loopar";
import {useDocument} from "@loopar/document";
import { useDesigner} from "@context/designer-context";
import { useCaptcha, CaptchaSlot } from "./captcha-widget";
import { __ } from "@global/i18n";
import { formatDate } from "@global/format";

function getInitials(name = "") {
  return name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

function getStoredVote(reviewId) {
  try { return localStorage.getItem(`review_vote_${reviewId}`); } catch { return null; }
}

function storeVote(reviewId, type) {
  try { localStorage.setItem(`review_vote_${reviewId}`, type); } catch {}
}

function Stars({ count = 5, interactive = false, onChange }) {
  const [hovered, setHovered] = useState(0);
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((v) => (
        <span
          key={v}
          className={`text-base leading-none select-none transition-colors ${
            v <= (interactive ? hovered || count : count)
              ? "text-amber-500"
              : "text-muted-foreground opacity-30"
          } ${interactive ? "cursor-pointer" : ""}`}
          onMouseEnter={() => interactive && setHovered(v)}
          onMouseLeave={() => interactive && setHovered(0)}
          onClick={() => interactive && onChange?.(v)}
        >★</span>
      ))}
    </div>
  );
}

function Avatar({ name }) {
  return (
    <div className="w-9 h-9 rounded-full bg-secondary text-secondary-foreground flex items-center justify-center text-xs font-medium shrink-0">
      {getInitials(name)}
    </div>
  );
}

function VoteButtons({ review, entity }) {
  const [voted, setVoted] = useState(() => getStoredVote(review.name));
  const [helpful, setHelpful] = useState(Number(review.helpful) || 0);
  const [notHelpful, setNotHelpful] = useState(Number(review.not_helpful) || 0);
  const [loading, setLoading] = useState(false);

  const handleVote = async (type) => {
    if (voted || loading) return;
    setLoading(true);

    try {
      await loopar.call(entity, "voteReview", {
        body: { review_id: review.name, vote: type }
      });

      if (type === "helpful") setHelpful((n) => n + 1);
      else setNotHelpful((n) => n + 1);

      storeVote(review.name, type);
      setVoted(type);
    } catch (e) {
      console.error("Vote error:", e);
    } finally {
      setLoading(false);
    }
  };

  const btnClass = (type) =>
    `flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors ${
      voted === type
        ? "bg-primary text-primary-foreground"
        : voted || loading
        ? "opacity-40 cursor-not-allowed bg-secondary text-secondary-foreground"
        : "bg-secondary text-secondary-foreground hover:bg-primary hover:text-primary-foreground"
    }`;

  return (
    <div className="flex items-center gap-3 mt-2 pt-2 border-t">
      <span className="text-xs text-muted-foreground">{__("Helpful?")}</span>
      <button className={btnClass("helpful")}     onClick={() => handleVote("helpful")}     disabled={!!voted || loading}>👍 {helpful}</button>
      <button className={btnClass("not_helpful")} onClick={() => handleVote("not_helpful")} disabled={!!voted || loading}>👎 {notHelpful}</button>
    </div>
  );
}

function ReviewCard({ review , entity}) {
  return (
    <div className="bg-card text-card-foreground border rounded-xl p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Avatar name={review.author_name} />
        <div>
          <p className="text-sm font-medium leading-tight">{review.author_name}</p>
          <p className="text-xs text-muted-foreground">{review.city}</p>
        </div>
      </div>
      <Stars count={review.rating} />
      <p className="text-sm text-muted-foreground leading-relaxed">{review.comment}</p>
      <p className="text-xs text-muted-foreground opacity-60">
        {formatDate(review.creation, { month: "long", year: "numeric" })}
      </p>
      <VoteButtons review={review} entity={entity} />
    </div>
  );
}

function ReviewForm({ requireCity, requireRating, entity }) {
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");
  const {entityMenu, Document} = useDocument();
  const ts = useCaptcha();

  useEffect(() => {
    fetch("http://ip-api.com/json")
      .then((r) => r.json())
      .then((d) => { if (d.city) setCity(`${d.city}, ${d.region}`); })
      .catch(() => {});
  }, []);

  const handleSubmit = async () => {
    if (!name.trim()) return setError("Please enter your name.");
    if (requireRating && rating === 0) return setError("Please select a rating.");
    if (requireCity && !city.trim()) return setError("Please enter your city.");
    if (!comment.trim()) return setError("Please write your review.");
    if (!ts.ready) return setError("Please complete the verification.");

    setError("");
    setLoading(true);

    try {
      await loopar.call(Document.Entity.name, "addReview", {
        body: {
          author_name: name.trim(),
          rating,
          comment: comment.trim(),
          captcha_token: ts.token
        }
      });

      setSuccess(true);
    } catch (e) {
      setError(e?.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
      ts.reset();
    }
  };

  if (success) {
    return (
      <div className="bg-secondary text-secondary-foreground rounded-xl p-5 text-sm text-center leading-relaxed">
        {__("Thank you,")} <strong>{name}</strong>{__("! Your review has been submitted and will appear once approved.")}
      </div>
    );
  }

  return (
    <div className="bg-card text-card-foreground border rounded-xl p-5 flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium mb-2">
          {__("Your rating")} {requireRating && <span className="text-destructive">*</span>}
        </p>
        <Stars count={rating} interactive onChange={setRating} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">{__("Full name *")}</label>
          <input
            className="bg-secondary text-secondary-foreground rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            placeholder={__("Your name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {/* <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">
            City {requireCity && <span className="text-destructive">*</span>}
          </label>
          <input
            className="bg-secondary text-secondary-foreground rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            placeholder="Boston, MA"
            value={city}
            onChange={(e) => setCity(e.target.value)}
          />
        </div> */}
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">{__("Your review *")}</label>
        <textarea
          className="bg-secondary text-secondary-foreground rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary resize-none h-24"
          placeholder={__("Tell us about your experience...")}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <CaptchaSlot captcha={ts} />

      <button
        className="self-start bg-primary text-primary-foreground rounded-lg px-5 py-2 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        onClick={handleSubmit}
        disabled={loading || !ts.ready}
      >
        {loading ? "Submitting..." : "Submit review"}
      </button>
    </div>
  );
}

function MetaReview({
  data
}) {
  const {show_avg, show_form, page_size, require_city, require_rating, 
    title="Review", 
    description="Review"
  } = data;

  const [reviews, setReviews] = useState(data.reviews || []);
  const [visible, setVisible] = useState(page_size);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const {entityMenu: entity, Document} = useDocument();
  const {designerMode, designing} = useDesigner();

  const displayed = reviews.slice(0, visible);
  const hasMore   = visible < reviews.length;

  const avg = reviews.length
    ? (reviews.reduce((s, r) => s + Number(r.rating), 0) / reviews.length).toFixed(1)
    : null;

  const loadReviews = async () => {
    setReviews(await loopar.call(entity, "getReviews"))
  }

  useRealtime(`Review.changed`, () => {
    loadReviews()
  });

  return (
    <section className="w-full py-12 px-4">
      <div className="max-w-4xl mx-auto flex flex-col gap-8">
        <div className="text-center">
          <h2 className="text-2xl font-medium">{title}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {description}
          </p>
        </div>

        {show_avg && avg && (
          <div className="bg-secondary text-secondary-foreground rounded-xl px-6 py-4 flex items-center gap-5">
            <span className="text-4xl font-medium leading-none">{avg}</span>
            <div className="flex flex-col gap-1">
              <Stars count={Math.round(parseFloat(avg))} />
              <span className="text-xs text-muted-foreground">
                {reviews.length === 1 ? __("Based on 1 review") : __("Based on {0} reviews", [reviews.length])}
              </span>
            </div>
          </div>
        )}

        {loading ? (
          <div className="text-sm text-muted-foreground text-center py-8">{__("Loading reviews...")}</div>
        ) : error ? (
          <div className="text-sm text-destructive text-center py-8">{error}</div>
        ) : reviews.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-8">
            {__("No reviews yet. Be the first to leave one!")}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {displayed.map((r) => <ReviewCard key={r.name} review={r} entity={entity} />)}
            </div>

            {hasMore && (
              <div className="flex justify-center">
                <button
                  onClick={() => setVisible((v) => v + page_size)}
                  className="bg-secondary text-secondary-foreground rounded-lg px-6 py-2.5 text-sm font-medium hover:opacity-80 transition-opacity"
                >
                  {__("Load more reviews")}
                </button>
              </div>
            )}

            {!hasMore && reviews.length > page_size && (
              <p className="text-xs text-muted-foreground text-center">
                {__("All {0} reviews loaded", [reviews.length])}
              </p>
            )}
          </>
        )}

        {show_form && (
          <>
            <div className="border-t" />
            <div className="flex flex-col gap-3">
              <h3 className="text-lg font-medium">{__("Leave a review")}</h3>
              <p className="text-sm text-muted-foreground -mt-2">
                {data.message}
              </p>
              {!designerMode &&
              <ReviewForm
                entity={entity}
                requireCity={require_city}
                requireRating={require_rating}
              />}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

MetaReview.metaFields = () => {
  return [
    {
      group: "custom",
      elements: {
        show_avg: { element: SWITCH },
        show_form: { element: SWITCH },
        require_city: { element: SWITCH },
        require_rating: { element: SWITCH },
        page_size: { element: INPUT, data: {format: "int"} },
        title: {element: TEXTAREA},
        description: {element: TEXTAREA},
        message: {element: TEXTAREA},
      }
    },
  ];
};

export default withRoot(MetaReview);
