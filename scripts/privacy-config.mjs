export function publicContact(env = process.env) {
  const email = String(env.PRIVACY_CONTACT_EMAIL || "").trim();
  if (!email) return null;
  if (email.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(email)) throw new Error("Invalid public privacy contact email");
  return email;
}
