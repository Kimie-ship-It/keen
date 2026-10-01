import * as sqlite from "./reviews.mjs";
import { checkPostgresAuthorization, listPostgresReviews, updatePostgresReview } from "./postgres-reviews.mjs";

export const readBearerToken = sqlite.readBearerToken;
export const validateReviewInput = sqlite.validateReviewInput;
export const checkAdminAuthorization = (db, ...args) => db.dialect === "postgres" ? checkPostgresAuthorization(db, ...args) : sqlite.checkAdminAuthorization(db, ...args);
export const listPendingReviews = (db, ...args) => db.dialect === "postgres" ? listPostgresReviews(db, ...args) : sqlite.listPendingReviews(db, ...args);
export const updateReview = (db, ...args) => db.dialect === "postgres" ? updatePostgresReview(db, ...args) : sqlite.updateReview(db, ...args);
