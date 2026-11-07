"""Generate Kokoro → RVC clips with final-audio lip sync, without an LLM."""

import argparse
import asyncio
import json
from pathlib import Path
import shutil
import time

from controller.speech import ApplioSettings, ApplioWorker, ROOT, Segment, synthesise


async def audition(args) -> None:
    settings = ApplioSettings(tts_provider='kokoro', kokoro_voice=args.voice,
                             kokoro_speed=args.speed, kokoro_threads=args.threads,
                             kokoro_clause_pause=args.clause_pause,
                             sentence_tail=args.sentence_tail, fragment_tail=args.fragment_tail,
                             mood_prosody=args.mood_prosody,
                             punctuation_cadence=args.punctuation_cadence,
                             ellipsis_tail=args.ellipsis_tail, exclaim_tail=args.exclaim_tail,
                             question_tail=args.question_tail, rvc_threads=args.rvc_threads)
    settings.check()
    worker = ApplioWorker(settings)
    directory = args.output_dir.resolve()
    results = []
    try:
        ready = await worker.start()
        print(json.dumps({'worker': ready, 'kokoro': worker.kokoro.ready}), flush=True)
        texts = args.text or ['Good evening! I am ready to keep you company.',
                              'We can test my new local voice together.']
        for mood, weight in args.mood or [('soft-smile', 0.6)]:
            for number, text in enumerate(texts, 1):
                started = time.perf_counter()
                clip, metrics = await synthesise(Segment(text, mood, weight), worker,
                                                 'kokoro-audition', directory)
                # A readable copy, so clips can be compared by mood without reading results.json.
                named = directory / f'{mood}-{weight:g}-{number}.wav'
                shutil.copyfile(directory / f'{clip}.wav', named)
                result = {'text': text, 'mood': mood, 'weight': weight, 'named': str(named),
                          'audio': str(directory / f'{clip}.wav'),
                          'visemes': str(directory / f'{clip}.visemes.json'),
                          'wallSeconds': round(time.perf_counter() - started, 3), **metrics}
                result['settings'] = {'voice': args.voice, 'speed': args.speed,
                                      'clausePause': args.clause_pause,
                                      'sentenceTail': args.sentence_tail,
                                      'fragmentTail': args.fragment_tail,
                                      'moodProsody': args.mood_prosody,
                                  'punctuationCadence': args.punctuation_cadence}
                results.append(result)
                print(json.dumps(result), flush=True)
    finally:
        await worker.close()
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'results.json').write_text(json.dumps(results, indent=2) + '\n', encoding='utf-8')


def mood_arg(value: str) -> tuple[str, float]:
    """Parse ``name`` or ``name:weight`` (weight 0–1) for --mood."""
    name, _, weight = value.partition(':')
    if not name.replace('-', '').isalnum():
        raise argparse.ArgumentTypeError(f'invalid mood name: {name!r}')
    try:
        number = float(weight) if weight else 1.0
    except ValueError:
        raise argparse.ArgumentTypeError(f'invalid mood weight: {weight!r}') from None
    if not 0.0 <= number <= 1.0:
        raise argparse.ArgumentTypeError('mood weight must be between 0 and 1')
    return name, number


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--text', action='append')
    parser.add_argument('--voice', default='af_heart:0.7,af_bella:0.3')
    parser.add_argument('--speed', type=float, default=1.0)
    parser.add_argument('--clause-pause', type=float, default=0.25)
    parser.add_argument('--sentence-tail', type=float, default=0.4)
    parser.add_argument('--fragment-tail', type=float, default=0.1)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--rvc-threads', type=int, default=4)
    parser.add_argument('--mood', type=mood_arg, action='append',
                        help='Mood for every --text, as name or name:weight; repeat to compare.')
    parser.add_argument('--punctuation-cadence', action='store_true',
                        help='Per-ending gaps, ! pitch by mood, slower ellipses, dashes as pauses.')
    parser.add_argument('--ellipsis-tail', type=float, default=0.6)
    parser.add_argument('--exclaim-tail', type=float, default=0.3)
    parser.add_argument('--question-tail', type=float, default=0.4)
    parser.add_argument('--mood-prosody', action='store_true',
                        help='Apply mood-driven speed, pauses and RVC pitch.')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'assets/private/speech/kokoro-audition')
    asyncio.run(audition(parser.parse_args()))


if __name__ == '__main__':
    main()
