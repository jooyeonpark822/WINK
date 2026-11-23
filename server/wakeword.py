"""노트북 서버용 호출어("윙크야") 감지기. openWakeWord 모델(models/wink_ya.onnx)을 쓴다.

server.js(wakeDetector.js)가 이 프로그램을 띄우고, 안경 마이크 소리(16kHz, 16비트, 모노 PCM)를
표준입력으로 계속 넣어 준다. 호출어가 들리면 표준출력으로 JSON 한 줄을 내보낸다:
    {"event": "wake", "score": 0.93}

openWakeWord 방식:
  소리 80ms(1280샘플)마다 -> 멜 스펙트로그램 -> 임베딩 -> 호출어 모델(wink_ya.onnx)이 0~1 점수를 냄
  -> 점수가 기준(threshold) 이상이면 호출어.

모델 파일 경로는 이 파일 기준(../models/wink_ya.onnx)이라, 폴더 이름이 바뀌어도
server 폴더와 models 폴더의 위치 관계만 그대로면 동작한다.

실행 예: .venv\\Scripts\\python wakeword.py --debug < 소리.pcm
"""
import argparse
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL = os.path.join(HERE, '..', 'models', 'wink_ya.onnx')
DEFAULT_WORD = '윙크야'
DEFAULT_THRESHOLD = 0.5
COOLDOWN_S = 2.0          # 한 번 감지한 뒤 이 시간 동안은 다시 감지하지 않는다
BYTES_PER_SAMPLE = 2
CHUNK_SAMPLES = 1280      # 80ms (openWakeWord가 권장하는 입력 단위)
CHUNK_BYTES = CHUNK_SAMPLES * BYTES_PER_SAMPLE


class OpenWakeWord:
    def __init__(self, model_path, threshold, word):
        from openwakeword.model import Model
        # 검증 모델(train_verifier.py로 만든 내 목소리용 필터)이 있으면 같이 쓴다. 지우면 기존 모델만 쓴다.
        name = os.path.splitext(os.path.basename(model_path))[0]
        verifier = os.path.join(os.path.dirname(os.path.abspath(model_path)), name + '_verifier.joblib')
        kw = {'custom_verifier_models': {name: verifier}} if os.path.isfile(verifier) else {}
        self.model = Model(wakeword_models=[model_path], inference_framework='onnx', **kw)
        self.name = next(iter(self.model.models))   # 점수 사전의 키 (파일 이름에서 .onnx를 뺀 것)
        self.threshold = threshold
        self.leftover = b''
        self.last_wake = 0.0
        self.max_score = 0.0   # 최근 1초 동안의 최고 점수 (--debug 용)
        self.info = {'engine': 'openwakeword', 'word': word, 'model': os.path.basename(model_path),
                     'cutoff': threshold, 'verifier': bool(kw)}

    def feed(self, data):
        data = self.leftover + data
        usable = len(data) - (len(data) % CHUNK_BYTES)
        self.leftover = data[usable:]
        wake_score = None
        for offset in range(0, usable, CHUNK_BYTES):
            pcm = np.frombuffer(data[offset:offset + CHUNK_BYTES], dtype=np.int16)
            score = float(self.model.predict(pcm)[self.name])
            self.max_score = max(self.max_score, score)
            now = time.monotonic()
            if score >= self.threshold and now - self.last_wake >= COOLDOWN_S:
                self.last_wake = now
                wake_score = score
                # 감지 직후 모델의 기억(최근 몇 초의 소리 특징)을 비운다.
                # 서버는 대화하는 동안 이 감지기에 소리를 넣지 않는다. 비우지 않으면 방금 들은 "윙크야"가 기억에 남아 있다가,
                # 대화가 끝나고 소리를 다시 넣는 순간 아무 말을 안 해도 또 감지된다. (첫 대답 뒤 오감지의 원인)
                self.model.reset()
                self.leftover = b''
                break
        return wake_score


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default=DEFAULT_MODEL, help='호출어 모델 파일 (기본: ../models/wink_ya.onnx)')
    ap.add_argument('--word', default=DEFAULT_WORD, help='화면에 보여줄 호출어 이름 (기본: 윙크야)')
    ap.add_argument('--threshold', type=float, default=DEFAULT_THRESHOLD, help='호출어로 볼 점수 기준 0~1 (기본: 0.5)')
    ap.add_argument('--debug', action='store_true', help='1초마다 가장 높았던 점수를 stderr에 출력')
    args = ap.parse_args()

    if not os.path.isfile(args.model):
        print(f'호출어 모델 파일이 없습니다: {os.path.abspath(args.model)}', file=sys.stderr, flush=True)
        sys.exit(2)

    detector = OpenWakeWord(args.model, args.threshold, args.word)
    print(json.dumps({'event': 'ready', **detector.info}, ensure_ascii=False), flush=True)

    stdin = sys.stdin.buffer
    last_dbg = time.monotonic()
    while True:
        data = stdin.read1(3200)
        if not data:
            break
        score = detector.feed(data)
        if score is not None:
            print(json.dumps({'event': 'wake', 'score': round(score, 3)}), flush=True)
        if args.debug and time.monotonic() - last_dbg >= 1.0:
            print(f'[debug] 최근 1초 최고 점수 {detector.max_score:.2f}', file=sys.stderr, flush=True)
            detector.max_score = 0.0
            last_dbg = time.monotonic()


if __name__ == '__main__':
    main()
