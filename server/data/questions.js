'use strict';
// Yes / Maybe / No personality questions.
//   dim    - the personality dimension (used for the vibe summary)
//   w      - importance weight in the match formula
//   mode   - 'similar'   : disagreement hurts fully (shared values / social style)
//            'flex'      : people can differ and still click (disagreement hurts half)
//   yes/no - the short "vibe phrase" shown when two people both answer that way
//   starter- a conversation opener used when both answered the same way
const Q = (id, dim, w, mode, text, yes, no, starter) => ({ id, dim, w, mode, text, yes, no, starter });

const QUESTIONS = [
  Q('q_recharge', 'energy', 1.4, 'similar', 'After socialising, I need time alone to recharge.',
    'recharge-alone', 'high-social-battery', 'How do you like to recharge after a long day?'),
  Q('q_oneonone', 'energy', 1.4, 'similar', 'I prefer 1-on-1 hangouts over big groups.',
    'one-on-one', 'group-hangout', 'Is your ideal hangout just two people, or a small crew?'),
  Q('q_quiet', 'energy', 1.1, 'similar', 'I’d choose a quiet, low-key place over a loud, busy one.',
    'low-key', 'lively', 'What’s your perfect quiet corner?'),
  Q('q_silence', 'energy', 0.9, 'similar', 'Comfortable silence with a friend feels fine to me.',
    'comfortable-in-silence', 'chatty', 'Do you have a friend you can sit in silence with?'),
  Q('q_deep', 'depth', 1.5, 'similar', 'I love deep, meaningful conversations more than small talk.',
    'deep-talker', 'light-chat', 'What topic could you talk about for hours?'),
  Q('q_one_close', 'depth', 1.2, 'similar', 'I’d rather have a few close friends than many casual ones.',
    'loyal', 'social-butterfly', 'What does a really good friendship look like to you?'),
  Q('q_checkin', 'empathy', 1.0, 'similar', 'I’m usually the one who checks in on my friends.',
    'caring', 'independent', 'Who’s someone who always checks in on you?'),
  Q('q_text', 'pace', 1.0, 'similar', 'I like getting to know someone over text before meeting.',
    'text-first', 'meet-sooner', 'Are you more of a texter or a "let’s just meet" person?'),
  Q('q_slow', 'pace', 0.9, 'similar', 'I’m okay with slow replies — no pressure to answer instantly.',
    'slow-and-steady', 'quick-replier', 'How do you feel about replying fast vs. in your own time?'),
  Q('q_plan', 'style', 0.8, 'flex', 'I like to plan things ahead rather than be spontaneous.',
    'planner', 'spontaneous', 'Are you a planner or a go-with-the-flow person?'),
  Q('q_routine', 'style', 0.6, 'flex', 'I enjoy routines and familiar places.',
    'routine-lover', 'novelty-seeker', 'What’s a small routine you secretly love?'),
  Q('q_novel', 'openness', 1.1, 'flex', 'I like trying new things, even if it feels a bit awkward.',
    'curious', 'comfort-seeking', 'What’s the last new thing you tried?'),
  Q('q_homebody', 'lifestyle', 1.2, 'similar', 'I’m a homebody — my ideal weekend is mostly indoors.',
    'homebody', 'outdoorsy', 'What does your perfect cosy weekend look like?'),
  Q('q_night', 'lifestyle', 0.8, 'flex', 'I’m more of a night owl than an early bird.',
    'night-owl', 'early-bird', 'Night owl or early bird — and what do you do with that time?'),
  Q('q_humor', 'humor', 1.0, 'similar', 'I use a lot of humour, memes or sarcasm when I talk.',
    'meme-fluent', 'earnest', 'What’s the last thing that made you properly laugh?'),
  Q('q_kind', 'values', 1.5, 'similar', 'Being kind matters more to me than being right.',
    'kind-first', 'debate-lover', 'What’s a small act of kindness you still remember?'),
];

const QUESTION_MAP = Object.fromEntries(QUESTIONS.map((q) => [q.id, q]));
const ANSWER_VALUES = { yes: 1, maybe: 0.5, no: 0 };

module.exports = { QUESTIONS, QUESTION_MAP, ANSWER_VALUES };
