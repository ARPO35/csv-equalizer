import { describe, expect, it } from 'vitest'
import { parseCurveCsv } from './csv'

const VDSF_SAMPLE = `20\t-14.7
21\t-14.6
22\t-14.6
23\t-14.6
24\t-14.5
26\t-14.4
27\t-14.4
29\t-14.2
30\t-14.2
32\t-14
34\t-13.9
36\t-13.8
38\t-13.6
40\t-13.5
43\t-13.3
45\t-13.2
48\t-13
50\t-12.9
53\t-12.8
56\t-12.7
59\t-12.6
63\t-12.4
66\t-12.4
70\t-12.3
74\t-12.2
78\t-12.1
83\t-12
87\t-12
92\t-11.9
97\t-11.9
103\t-11.8
109\t-11.8
115\t-11.7
121\t-11.7
128\t-11.6
136\t-11.5
143\t-11.4
151\t-11.3
160\t-11.2
169\t-11
178\t-10.9
188\t-10.7
199\t-10.5
210\t-10.3
222\t-10.1
235\t-9.8
248\t-9.6
262\t-9.3
277\t-9
292\t-8.8
309\t-8.5
326\t-8.2
345\t-8
364\t-7.8
385\t-7.5
406\t-7.3
429\t-7
453\t-6.8
479\t-6.5
506\t-6.2
534\t-6
565\t-5.8
596\t-5.5
630\t-5.3
665\t-5.2
703\t-5
743\t-4.9
784\t-4.9
829\t-4.9
875\t-4.9
924\t-5
977\t-5.2
1032\t-5.4
1090\t-5.6
1151\t-5.8
1216\t-6.1
1284\t-6.3
1357\t-6.4
1433\t-6.6
1514\t-6.8
1599\t-6.9
1689\t-7
1784\t-7
1885\t-7
1991\t-6.9
2103\t-6.7
2221\t-6.4
2347\t-6
2479\t-5.7
2618\t-5.4
2766\t-5
2921\t-4.7
3086\t-4.6
3260\t-4.7
3443\t-5
3637\t-5.3
3842\t-5.6
4058\t-5.7
4287\t-5.5
4528\t-5.1
4783\t-4.4
5052\t-3.7
5337\t-3
5637\t-2.3
5955\t-1.6
6290\t-0.9
6644\t-1.1
7018\t-2.1
7414\t-2.8
7831\t-3
8272\t-3.2
8738\t-3.6
9230\t-4.2
9749\t-5.1
10298\t-5.5
10878\t-5.3
11490\t-5.2
12137\t-4.9
12821\t-4.5
13543\t-4.1
14305\t-3.6
15110\t-3
15961\t-2.5
16860\t-1.9
17809\t-1.3
18812\t-0.8
19871\t-0.2`

describe('parseCurveCsv', () => {
  it('parses a valid frequency/gain csv', () => {
    const curve = parseCurveCsv('frequency,gain\n20,-3\n1000,0\n20000,2.5')
    expect(curve).toEqual([
      { frequencyHz: 20, gainDb: -3 },
      { frequencyHz: 1000, gainDb: 0 },
      { frequencyHz: 20000, gainDb: 2.5 },
    ])
  })

  it('accepts header aliases and sorts the result', () => {
    const curve = parseCurveCsv('hz;db\n1000;0\n20;-3\n20000;2.5')
    expect(curve).toEqual([
      { frequencyHz: 20, gainDb: -3 },
      { frequencyHz: 1000, gainDb: 0 },
      { frequencyHz: 20000, gainDb: 2.5 },
    ])
  })

  it('parses vdsf style tab-delimited data without a header', () => {
    const curve = parseCurveCsv(VDSF_SAMPLE)
    expect(curve[0]).toEqual({ frequencyHz: 20, gainDb: -14.7 })
    expect(curve.at(-1)).toEqual({ frequencyHz: 19871, gainDb: -0.2 })
  })

  it('rejects duplicate frequency values', () => {
    expect(() => parseCurveCsv('frequency,gain\n20,0\n20,1')).toThrow(
      'Frequency values must be unique.',
    )
  })
})
