/** A negative answer to an optional preference question keeps the enquiry open. */
export function answersNoPreference(message: string, previousAssistant?: string) {
  if (!/^(?:no|nope|nah|no preference|not really|any(?:thing)? is fine|either is fine)[.!?\s]*$/i.test(message.trim())) return false;
  return /\b(?:do you have (?:a |any )?prefer(?:red|ence)|any preference|(?:a |any )?preferred (?:finish|colou?r|material|brand|size)|have (?:a |any )?(?:finish|colou?r|material|brand|size) preference)\b[^?]*\?/i.test(previousAssistant ?? "");
}
