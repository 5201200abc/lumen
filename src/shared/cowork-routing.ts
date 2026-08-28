const DIRECT_CONVERSATION_PATTERNS = [
  /^(?:你|您)(?:(?:会|能|可以)(?:做|干)(?:些)?(?:什么|哪些(?:事|事情|工作)?)|(?:能|可以)(?:帮我|帮助我)(?:做)?(?:什么|哪些(?:事|事情|工作)?))[？?。!！]*$/i,
  /^(?:你|您)(?:有|具备)(?:哪些|什么)(?:能力|功能)[？?。!！]*$/i,
  /^(?:你|您)是谁[？?。!！]*$/i,
  /^(?:介绍|说说)(?:一下)?(?:你自己|你的能力|你的功能)[？?。!！]*$/i,
  /^(?:你好|您好|嗨|哈喽|hello|hi|hey)[！!。.]?$/i,
  /^(?:what can you do|tell me what you can do|how can you help(?: me)?|what are your capabilities|who are you)[？?。.!！]*$/i
] as const;

export function isCoworkDirectConversation(prompt: string, hasAttachments = false): boolean {
  if (hasAttachments) return false;
  const text = prompt.replace(/\s+/g, " ").trim();
  return text.length > 0 &&
    text.length <= 120 &&
    DIRECT_CONVERSATION_PATTERNS.some((pattern) => pattern.test(text));
}
