"""노트북 서버용 호출어 검증 모델 학습: 내 목소리로 "윙크야"와 오감지 소리를 구분하게 만든다.

기존 호출어 모델(models/wink_ya.onnx)이 "윙크야 같다"고 판단했을 때, 이 검증 모델이 한 번 더 걸러 준다.
입력: server/wake_data/pos/*.wav ("윙크야"만 말한 녹음), server/wake_data/neg/*.wav (소음·평범한 말 녹음)
출력: models/wink_ya_verifier.joblib  (wakeword.py가 파일이 있으면 자동으로 쓴다)

실행: .venv\\Scripts\\python train_verifier.py            (전체 데이터로 학습해서 저장)
      .venv\\Scripts\\python train_verifier.py --eval     (각 녹음의 앞 70%로 학습, 뒤 30%로 시험만 하고 저장 안 함)
"""
import argparse
import glob
import os
import tempfile
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, '..', 'models', 'wink_ya.onnx')
OUT = os.path.join(HERE, '..', 'models', 'wink_ya_verifier.joblib')
DATA = os.path.join(HERE, 'wake_data')
CHUNK = 1280          # 80ms
COOLDOWN_CHUNKS = 25  # 2초 (wakeword.py의 COOLDOWN_S와 같다)


def load(label):
    clips = []
    for f in sorted(glob.glob(os.path.join(DATA, label, '*.wav'))):
        with wave.open(f) as w:
            clips.append(np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16))
    return clips


def scores(audio, verifier=None):
    """녹음을 실시간처럼 흘려 넣고 80ms마다 점수를 돌려준다."""
    from openwakeword.model import Model
    kw = {'custom_verifier_models': {'wink_ya': verifier}} if verifier else {}
    m = Model(wakeword_models=[MODEL], inference_framework='onnx', **kw)
    out = []
    for i in range(0, len(audio) - CHUNK, CHUNK):
        out.append(float(m.predict(audio[i:i + CHUNK])['wink_ya']))
    return np.array(out)


def events(sc, thr):
    n, last = 0, -10**9
    for i, s in enumerate(sc):
        if s >= thr and i - last >= COOLDOWN_CHUNKS:
            n += 1
            last = i
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--eval', action='store_true', help='뒤 30%를 시험용으로 빼고 학습해서 결과만 본다 (저장 안 함)')
    args = ap.parse_args()

    from openwakeword.custom_verifier_model import train_custom_verifier
    pos, neg = load('pos'), load('neg')
    if not pos or not neg:
        raise SystemExit('wake_data/pos 와 wake_data/neg 에 WAV 녹음이 있어야 합니다.')

    if args.eval:
        cut = lambda a: (a[:int(len(a) * 0.7)], a[int(len(a) * 0.7):])
        pos_tr, pos_te = zip(*[cut(a) for a in pos])
        neg_tr, neg_te = zip(*[cut(a) for a in neg])
        out = os.path.join(tempfile.mkdtemp(), 'v.joblib')
    else:
        pos_tr, neg_tr, out = pos, neg, OUT

    train_custom_verifier(list(pos_tr), list(neg_tr), out, MODEL)
    if not args.eval:
        print(f'저장했습니다: {os.path.abspath(out)}')
        return

    test_pos, test_neg = np.concatenate(pos_te), np.concatenate(neg_te)
    print(f'\n시험 구간: "윙크야" {len(test_pos) / 16000:.0f}초, 소음·평범한 말 {len(test_neg) / 16000:.0f}초 (학습에 쓰지 않은 부분)')
    for name, ver in [('기존 모델만', None), ('검증 모델 추가', out)]:
        sp, sn = scores(test_pos, ver), scores(test_neg, ver)
        print(f'\n[{name}]  기준별: "윙크야" 감지 횟수 / 소음·평범한 말에서 오감지 횟수')
        for t in (0.3, 0.5, 0.7, 0.9):
            print(f'  기준 {t}: 윙크야 {events(sp, t)}번 감지 / 오감지 {events(sn, t)}번')


if __name__ == '__main__':
    main()
