(function () {
	'use strict';

	window.APP_NAME = 'genghis';
	window.BG = (function (SM, PQ, RM) {
		const GAP_TIME = 300,
			REPEAT_SEARCH_DELAY = 6 * 60 * 60 * 1000; //6 HOURS

		var sendEmailTimeout, repeatSearchTimeout;

		// public methods
		return {
			initServer: initServer,
			stopServer: stopServer,
			showLoading: showLoading,
			hideBadge: hideBadge,
			saveRequest: saveRequest,
			getRequests: getRequests,
			deleteRequests: deleteRequests,
			deleteResults: deleteResults,
			getResults: getResults,
			getSites: getSites,
			getInitialNumberOfFlights: getInitialNumberOfFlights,
		};

		function initServer(req) {
			var time = new Date().getTime();
			stopServer();

			var k, w;
			for (var i = 0; i < req.origins.length; i++) {
				for (var j = 0; j < req.destinations.length; j++) {
					var origin = req.origins[i],
						destination = req.destinations[j];
					if (origin === destination) continue;

					for (var k = 0; k < req.departures.length; k++) {
						var departure = req.departures[k];

						if (req.qtyDays !== null && req.qtyDays.length > 0) {
							for (var w = 0; w < req.qtyDays.length; w++) {
								var qtyDays = req.qtyDays[w];

								var returnDate = null; // oneway
								if (qtyDays >= 0) // roundtrip
									returnDate = new Date(departure).setHours(24 * qtyDays, 0, 0, 0);

								enqueue(origin, destination, departure, returnDate,
									req.adults, req.children, req.infants, req.site, time);

								time += GAP_TIME;
							}

							continue;
						}

						// oneway
						if (req.returns === null || req.returns.length === 0) {
							enqueue(origin, destination, departure, null,
								req.adults, req.children, req.infants, req.site, time);

							time += GAP_TIME;
							continue;
						}

						// roundtrip
						for (var w = 0; w < req.returns.length; w++) {
							var returnDate = req.returns[w];
							if (departure > returnDate) continue;

							enqueue(origin, destination, departure, returnDate,
								req.adults, req.children, req.infants, req.site, time);

							time += GAP_TIME;
						}
					}
				}
			}

			setTimeout(function () {
				saveRequest(req);
				PQ.initServer(getResponse);
			}, 1);

			setupRepeatSearch(req);

			return saveInitialNumberOfFlights();
		}

		function stopServer() {
			PQ.stopServer();
			saveInitialNumberOfFlights();
		}

		function showLoading() {
			return PQ.getLength() !== 0 && getResults().length === 0;
		}

		function hideBadge() {
			chrome.browserAction.setBadgeText({
				text: ''
			});
		}

		function saveRequest(request) {
			if (!request || Object.keys(request).length === 0) return;

			var requests = getRequests();
			for (var i in requests) {
				var savedRequest = requests[i];

				// if it has same origins and destinations as an old request, override it
				var hasSameOriginsAndDepartures =
					request.origins.length === savedRequest.origins.length &&
					request.destinations.length === savedRequest.destinations.length;

				if (hasSameOriginsAndDepartures) {
					for (var j in request.origins) {
						if (savedRequest.origins.indexOf(request.origins[j]) === -1) {
							hasSameOriginsAndDepartures = false;
							break;
						}
					}
				}

				if (hasSameOriginsAndDepartures) {
					for (var j in request.destinations) {
						if (savedRequest.destinations.indexOf(request.destinations[j]) === -1) {
							hasSameOriginsAndDepartures = false;
							break;
						}
					}
				}

				if (hasSameOriginsAndDepartures) {
					requests.splice(i, 1); // remove it
					break;
				}
			}

			requests.splice(0, 0, request); // save it on beginning
			SM.put('requests', JSON.stringify(requests));
		}

		function getRequests() {
			return JSON.parse(SM.get('requests')) || [];
		}

		function deleteRequests() {
			SM.delete('requests');
		}

		function deleteResults() {
			SM.delete('results');
		}

		function getResults() {
			return JSON.parse(SM.get('results')) || [];
		}

		function saveResults(results) {
			SM.put('results', JSON.stringify(results || []));
		}

		function getSites() {
			return RM.getInstances();
		}

		function getInitialNumberOfFlights() {
			return parseInt(SM.get('initialNumberOfFlights')) || 0;
		}

		// private methods
		function saveInitialNumberOfFlights() {
			var initialNumberOfFlights = PQ.getLength();
			SM.put('initialNumberOfFlights', initialNumberOfFlights);

			return initialNumberOfFlights;
		}

		function enqueue(origin, destination, departureDate, returnDate,
			adults, children, infants, site, time) {
			PQ.enqueue({
				origin: origin,
				destination: destination,
				departure: departureDate,
				return: returnDate,
				adults: adults,
				children: children,
				infants: infants,
				site: site,
				times: [time]
			});
		}

		function getResponse(request, response) {
			var results = savePricesReceived(request, response);
			var popup = chrome.extension.getViews({
				type: 'popup'
			})[0];

			if (popup !== undefined) {
				hideBadge();

				var scope = popup.angular
					.element(popup.document.getElementsByTagName('body'))
					.scope();

				scope.$apply(function () {
					scope.vm.updateResults(results);
				});
			} else {
				updateBadge();
			}

			if (request.email && request.priceEmail)
				sendEmailIfLowFare(request, results);
		}

		function savePricesReceived(request, response) {
			var results = getResults();

			results.push({
				origin: request.origin,
				destination: request.destination,
				departure: request.departure,
				return: request.return,
				url: request.url,
				prices: response.prices,
				byCompany: response.byCompany,
				minPrice: Math.min.apply(null, response.prices),
				key: request.origin + '-' + request.destination
			});

			results.sort(function (a, b) {
				return a.minPrice > b.minPrice ? 1 : (a.minPrice < b.minPrice ? -1 : a.key - b.key);
			});

			saveResults(results);

			return results;
		}

		function updateBadge() {
			chrome.browserAction.setBadgeBackgroundColor({
				color: [220, 0, 0, 255]
			});

			chrome.browserAction.setBadgeText({
				text: getResults().length.toString()
			});
		}

		function sendEmailIfLowFare(request, results) {
			var datesWithLowFare = '';
			for (var i in results) {
				var result = results[i];

				if (result.minPrice <= request.priceEmail) {
					var text = result.key + ' - ' + result.departure.toDateFormat('dd/MM/yyyy');

					if (result.return !== null) //roundtrip
						text += ' - ' + result.return.toDateFormat('dd/MM/yyyy');

					text += ' - ' + minPrice;
					datesWithLowFare += '<br/><a href="' + result.url + '">' + text + '</a>';
				}
			}

			if (datesWithLowFare !== '') {
				clearTimeout(sendEmailTimeout);

				sendEmailTimeout = setTimeout(function () {
					$.ajax({
						type: 'POST',
						url: 'https://mandrillapp.com/api/1.0/messages/send.json',
						data: {
							// please don't use this key. Sign up for https://mandrill.com/signup/ It's free!
							key: '9oF6KGko9Eg43LpgM2GCXA',
							message: {
								html: 'As seguintes datas têm preço menor que ' + request.priceEmail +
									':<br>' + datesWithLowFare + '<br><br>Att,<br>Passagens aéreas Genghis',
								subject: 'Passagens baratas encontradas',
								from_email: 'genghislabs@gmail.com',
								from_name: 'Passagens aéreas Genghis',
								to: [{
									email: request.email,
									type: 'to'
							}],
								headers: {
									'Reply-To': 'genghislabs@gmail.com'
								},
								auto_html: null,
								bcc_address: 'genghislabs@gmail.com'
							}
						}
					});

					clearTimeout(repeatSearchTimeout);
				}, 2000 * 60); // wait two minutes, enough time to fetch more results
			}
		}

		function setupRepeatSearch(req) {
			if (req === undefined) { // pc turn on, verify if we need do the saved search
				var timeToSearch = SM.get('repeatSearchTime');
				if (timeToSearch !== null) {
					clearTimeout(repeatSearchTimeout);

					repeatSearchTimeout = setTimeout(function () {
						initServer(JSON.parse(SM.get('repeatSearchRequest')));
					}, Math.max(1, parseInt(timeToSearch) - (new Date()).getTime()));
				}
			} else if (req.email && req.priceEmail) {
				var now = new Date();
				now.setMilliseconds(now.getMilliseconds() + REPEAT_SEARCH_DELAY);

				// saving ticks, in case the pc shutdown. So next time the pc turn on, we verify this
				SM.put('repeatSearchTime', now.getTime());
				SM.put('repeatSearchRequest', JSON.stringify(req));

				clearTimeout(repeatSearchTimeout);

				repeatSearchTimeout = setTimeout(function () {
					var request = JSON.parse(SM.get('repeatSearchRequest'));

					initServer(request);
				}, REPEAT_SEARCH_DELAY);
			} else {
				SM.delete('repeatSearchTime');
				SM.delete('repeatSearchRequest');

				clearTimeout(repeatSearchTimeout);
			}
		}

		// initial setup in case of turning on the pc
		setupRepeatSearch();

	}(window.StoreManager, window.PriorityQueue, window.RequestManager));
})();