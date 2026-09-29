const verbBaseMap = {
    // Launch verbs
    'launch': 'launch', 'launches': 'launch', 'launched': 'launch', 'launching': 'launch',
    'release': 'release', 'releases': 'release', 'released': 'release', 'releasing': 'release',
    'unveil': 'unveil', 'unveils': 'unveil', 'unveiled': 'unveil', 'unveiling': 'unveil',
    'announce': 'announce', 'announces': 'announce', 'announced': 'announce', 'announcing': 'announce',
    'debut': 'debut', 'debuts': 'debut', 'debuted': 'debut',
    'roll out': 'roll out', 'rollout': 'roll out',
    
    // Win verbs
    'win': 'win', 'wins': 'win', 'won': 'win', 'winning': 'win',
    'beat': 'beat', 'beats': 'beat', 'beaten': 'beat', 'beating': 'beat',
    'defeat': 'defeat', 'defeats': 'defeat', 'defeated': 'defeat', 'defeating': 'defeat',
    
    // Rise verbs
    'rise': 'rise', 'rises': 'rise', 'rose': 'rose', 'rising': 'rise',
    'surge': 'surge', 'surges': 'surge', 'surged': 'surge', 'surging': 'surge',
    'jump': 'jump', 'jumps': 'jump', 'jumped': 'jump', 'jumping': 'jump',
    'gain': 'gain', 'gains': 'gain', 'gained': 'gain', 'gaining': 'gain',
    
    // Fall verbs
    'fall': 'fall', 'falls': 'fall', 'fell': 'fall', 'fallen': 'fall', 'falling': 'fall',
    'drop': 'drop', 'drops': 'drop', 'dropped': 'drop', 'dropping': 'drop',
    'slump': 'slump', 'slumps': 'slump', 'slumped': 'slump', 'slumping': 'slump',
    'decline': 'decline', 'declines': 'decline', 'declined': 'decline', 'declining': 'decline',
    
    // Approve verbs
    'approve': 'approve', 'approves': 'approve', 'approved': 'approve', 'approving': 'approve',
    'pass': 'pass', 'passes': 'pass', 'passed': 'pass', 'passing': 'pass',
    
    // Ban verbs
    'ban': 'ban', 'bans': 'ban', 'banned': 'ban', 'banning': 'ban',
    'block': 'block', 'blocks': 'block', 'blocked': 'block', 'blocking': 'block',
    'halt': 'halt', 'halts': 'halt', 'halted': 'halt', 'halting': 'halt',
    'cancel': 'cancel', 'cancels': 'cancel', 'cancelled': 'cancel', 'cancelling': 'cancel',
    'suspend': 'suspend', 'suspends': 'suspend', 'suspended': 'suspend', 'suspending': 'suspend',
    'delay': 'delay', 'delays': 'delay', 'delayed': 'delay', 'delaying': 'delay',
    'postpone': 'postpone', 'postpones': 'postpone', 'postponed': 'postpone', 'postponing': 'postpone',
    
    // Action verbs
    'charge': 'charge', 'charges': 'charge', 'charged': 'charge', 'charging': 'charge',
    'investigate': 'investigate', 'investigates': 'investigate', 'investigated': 'investigate', 'investigating': 'investigate',
    'probe': 'probe', 'probes': 'probe', 'probed': 'probe', 'probing': 'probe'
};

function buildNewsQuestion(headline) {
    const clean = String(headline || '')
        .replace(/\s+-\s+[^-]+$/, '')
        .replace(/\[[^\]]+\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!clean) return 'Will this story be confirmed?';

    const lower = clean.toLowerCase();

    // 1. If it already looks like a question, just format it and return
    const isQuestion = clean.endsWith('?') || 
                       /^(will|is|are|can|could|should|would|does|do|did|has|have|had|whether|how|why|who|what|where)\b/i.test(clean);
    if (isQuestion) {
        let q = clean.charAt(0).toUpperCase() + clean.slice(1);
        if (!q.endsWith('?')) q += '?';
        return q;
    }

    // Sort keys by length descending so that longer phrases like "roll out" match before "roll"
    const sortedVerbKeys = Object.keys(verbBaseMap).sort((a, b) => b.length - a.length);
    
    // Find if any verb matches in the headline
    for (const verbKey of sortedVerbKeys) {
        const regex = new RegExp(`\\b${verbKey}\\b`, 'i');
        const match = clean.match(regex);
        if (match) {
            const index = match.index;
            const matchedWord = match[0];
            
            // Extract subject
            let subject = clean.slice(0, index)
                .replace(/^(breaking|update|exclusive|analysis|live|opinion):\s*/i, '')
                .trim();
            
            // Strip trailing "to", "for", "is", "are", or punctuation
            subject = subject.replace(/\s+(?:to|for|is|are|will|should|would|could|can|has|have|had)$/i, '');
            subject = subject.replace(/[,;:.\-\s]+$/g, '').trim();
            
            // Extract rest
            let rest = clean.slice(index + matchedWord.length).trim();
            rest = rest.replace(/[,;:.\s\?]+$/g, '').trim();
            
            const baseVerb = verbBaseMap[verbKey.toLowerCase()];
            
            if (subject && subject.split(/\s+/).length <= 6) {
                // Return formatted question
                let result = '';
                if (['approve', 'pass', 'ban', 'block', 'halt', 'cancel', 'suspend', 'delay', 'postpone'].includes(baseVerb)) {
                    // For these verbs, active voice "Will Subject Verb Rest?" or passive "Will Rest be approved/blocked?" can both be good.
                    // But active voice is almost always correct if Rest is not empty.
                    if (rest) {
                        result = `Will ${subject} ${baseVerb} ${rest}?`;
                    } else {
                        result = `Will ${subject} be ${baseVerb === 'approve' || baseVerb === 'pass' ? 'approved' : 'blocked'}?`;
                    }
                } else if (['charge', 'investigate', 'probe'].includes(baseVerb)) {
                    if (rest) {
                        result = `Will ${subject} ${baseVerb} ${rest}?`;
                    } else {
                        result = `Will ${subject} face action?`;
                    }
                } else {
                    result = `Will ${subject} ${baseVerb} ${rest}?`;
                }
                
                return result.replace(/\s+/g, ' ').replace(/\s+\?/g, '?').trim();
            }
        }
    }

    // Fallback: If no patterns match
    const subject = extractBetSubject(clean);
    return `Will ${subject} happen?`;
}

function extractBetSubject(headline) {
    const stopAt = headline
        .replace(/^(breaking|update|exclusive|analysis|live):\s*/i, '')
        .split(/\s+(?:as|after|amid|over|before|during|following|according to|says|said)\s+/i)[0]
        .replace(/["']/g, '')
        .trim();
    const words = stopAt.split(/\s+/).filter(Boolean).slice(0, 7);
    const subject = words.join(' ').replace(/[,;:.]+$/g, '').trim();
    return subject || 'this story';
}

const testHeadlines = [
    "Will Bitcoin rise to 100k?",
    "Apple announces new iPhone 18",
    "Donald Trump wins the election in landslide victory",
    "EU to approve new AI regulations",
    "China bans cryptocurrency transactions again",
    "US court charges Google with antitrust violations",
    "Global stocks plunge as inflation fears rise"
];

testHeadlines.forEach(h => {
    console.log(`Headline: "${h}"`);
    console.log(`Generated Question: "${buildNewsQuestion(h)}"\n`);
});
