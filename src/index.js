const {
  BaseKonnector,
  requestFactory,
  signin,
  log
} = require('cozy-konnector-libs')
let request = requestFactory()
let j = request.jar()
request = requestFactory({
  debug: true,
  cheerio: false,
  json: true,
  jar: j,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:65.0) Gecko/20100101 Firefox/65.0',
    'Accept-Language': 'fr,fr-FR;q=0.8,en-US;q=0.5,en;q=0.3'
  }
})

const requestHTML = requestFactory({
  debug: true,
  cheerio: true,
  json: false,
  jar: j,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:65.0) Gecko/20100101 Firefox/65.0',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'fr,fr-FR;q=0.8,en-US;q=0.5,en;q=0.3'
  }
})

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  await requestHTML('https://fnac.com')
  await authenticate(fields.login, fields.password)
  const $ = await requestHTML(`https://secure.fnac.com/MyAccount/Order`)
  global.openInBrowser($)
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

  // LOGIN FAILED
  log('info', 'Account seems valid')
  log('debug', 'Second login step ok, get an Oauth link')
  // Do a Oauth process with signin (GET then POST)
  await signin({
    url: OAuthUrl,
    requestInstance: requestHTML,
    formSelector: 'form'
  })
  log('debug', 'Third login step ok, logged back to fnac.com')

  // What's BAD :
  // .AUTH cookie not set at  complete-login
  // Order page redirect to a login process
  return
}
