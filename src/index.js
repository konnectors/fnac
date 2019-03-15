const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  log,
  saveBills,
  utils,
  errors
} = require('cozy-konnector-libs')
let request = requestFactory()
let j = request.jar()
const moment = require('moment')

const headers = {
  'User-Agent':
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:65.0) Gecko/20100101 Firefox/65.0 Cozycloud',
  'Accept-Language': 'fr,fr-FR;q=0.8,en-US;q=0.5,en;q=0.3'
}

request = requestFactory({
  // debug: 'simple',
  cheerio: false,
  json: true,
  jar: j,
  headers
})

const requestHTML = requestFactory({
  // debug: 'simple',
  cheerio: true,
  json: false,
  jar: j,
  headers
})

module.exports = new BaseKonnector(start)

async function start(fields) {
  await requestHTML('https://fnac.com')
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)

  const bills = formatBills(await fetchBills())

  await saveBills(bills, fields.folderPath, {
    requestInstance: requestHTML,
    identifiers: ['fnac']
  })
}

function formatBills(bills) {
  const VENDOR = 'Fnac'
  return bills.map(bill => ({
    ...bill,
    vendor: VENDOR,
    currency: '€',
    filename: `${utils.formatDate(bill.date)}_${VENDOR}_${bill.amount.toFixed(
      2
    )}€_${bill.vendorRef}.pdf`,
    metadata: {
      importDate: new Date(),
      version: 1
    }
  }))
}

// Cookie .AUTH and cookie UID seems mandatory to be connected
async function authenticate(username, password) {
  // Prefecth Oauth URL and token
  let firstOauthUrl = ''
  try {
    await request({
      followRedirect: false,
      uri: 'https://secure.fnac.com/identity/gateway/signin',
      followAllRedirects: false
    })
  } catch (err) {
    if (err.statusCode === 302) {
      firstOauthUrl = err.response.headers.location
    } else {
      throw err
    }
  }
  // Finish to follow 302
  await request(firstOauthUrl)

  const authorize_request_identifier = j
    .getCookies('https://secure.fnac.com')
    .find(cookie => cookie.key === 'authorize_request_identifier').value
  log('debug', 'First login step ok, get authorize_request_identifier')

  // First POST to API to get an OpenID token
  try {
    const reqPostApi = await request({
      url: 'https://secure.fnac.com/identity/server/api/v1/login',
      method: 'POST',
      headers: {
        authorization: 'Basic 23A17F49D34DE16BC85AB395F' //not needed maybe
      },
      form: {
        authenticationLocation: 'StandardCreation - Account',
        authorizeRequestIdentifier: authorize_request_identifier,
        email: username,
        password: password,
        redirectUri: firstOauthUrl
      }
    })
    const OAuthUrl = reqPostApi.RedirectUri
    log('info', 'Account seems valid')
    log('debug', 'Second login step ok, get an Oauth link')
    // Do a Oauth process with signin (GET then POST)
    await signin({
      url: OAuthUrl,
      requestInstance: requestHTML,
      formSelector: 'form'
    })
    log('debug', 'Third login step ok, logged back to fnac.com')
  } catch (err) {
    log('error', err.message)
    throw new Error(errors.LOGIN_FAILED)
  }
}

async function fetchBills() {
  let result = []
  for (const dateRangeType of [3, 4, 5, 6]) {
    const $ = await requestHTML(
      `https://secure.fnac.com/MyAccount/Order/GetOrders?DateRangeType=${dateRangeType}&OrderType=0`
    )

    const bills = scrape(
      $,
      {
        vendorRef: {
          sel: 'div',
          fn: $el => $el.closest('section').data('order-id')
        },
        date: {
          sel: '.ma-OrderTop>div>div>span:nth-child(1)',
          parse: date => moment(date, 'DD/MM/YYYY').toDate()
        },
        amount: {
          sel: '.ma-orderdetails-price, .ma-OrderDetails-price',
          parse: normalizePrice
        },
        fileurl: {
          sel: ".ma-OrderDetails-Link[href^='javascript']",
          attr: 'href',
          parse: href => href && href.match(/(https.*)'\)$/)[1]
        }
      },
      '.ma-Order'
    )

    result = result.concat(bills)
  }

  result = result.filter(bill => bill.fileurl)

  return result
}

// convert a price string to a float
function normalizePrice(price) {
  return parseFloat(
    price
      .replace('€', '')
      .replace(',', '.')
      .trim()
  )
}
