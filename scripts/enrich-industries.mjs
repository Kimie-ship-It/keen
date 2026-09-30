import { openDatabase, closeDatabase } from "./db.mjs";
import { classifyIndustries } from "./industries.mjs";

const db = await openDatabase();
try {
  const rows = db.prepare("SELECT id, company, title, job_type AS jobType FROM jobs ORDER BY id").all();
  const clear = db.prepare("DELETE FROM job_industries WHERE job_id=?");
  const add = db.prepare("INSERT OR IGNORE INTO job_industries (job_id, industry) VALUES (?, ?)");
  db.transaction(() => {
    for (const row of rows) {
      clear.run(row.id);
      for (const industry of classifyIndustries(row)) add.run(row.id, industry);
    }
  })();
  console.log(JSON.stringify({ checked: rows.length, classified: db.prepare("SELECT COUNT(DISTINCT job_id) AS total FROM job_industries").get().total, industries: db.prepare("SELECT COUNT(DISTINCT industry) AS total FROM job_industries").get().total }));
} finally {
  closeDatabase(db);
}
