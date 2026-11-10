// The closing clip of the tour: logging out ends every login of this account on the server.
export async function run(rec) {
  const { page } = rec
  await rec.shot('B16', '로그아웃', async () => {
    await rec.goto('/')
    rec.trimStart = Math.max(0, rec.at() - 0.2)
    await rec.caption('로그아웃하면 다시 데모만 볼 수 있는 상태로 돌아갑니다')
    await rec.pause(1200)
    await rec.press(page.getByRole('button', { name: '로그아웃' }))
    await page.getByRole('button', { name: '로그인' }).first().waitFor({ timeout: 15000 })
    // off the 로그인 button it brought back, so the button reads (review of 2026-10-30)
    await page.mouse.move(900, 300, { steps: 12 })
    await rec.pause(1500)
    await rec.caption('https://schemaforge-app.duckdns.org')
    await rec.pause(3000)
  })
}
