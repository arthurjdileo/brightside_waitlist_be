const functions = require('@google-cloud/functions-framework');
const axios = require("axios");

let cache = {
};

functions.http('eligibility', async (req, res) => {
    res.set('Access-Control-Allow-Origin', "https://brightsidecounseling.org");
	if (req.method === 'OPTIONS') {
		// Send response to OPTIONS requests
		res.set('Access-Control-Allow-Methods', 'POST');
		res.set('Access-Control-Allow-Headers', 'Content-Type');
		res.status(204).send('');
		return;
	}

    let body = `Client_Id=${process.env.PVERIFY_CLIENT_ID}&client_secret=${process.env.PVERIFY_SECRET}&grant_type=client_credentials`;
	try {

		let fname = req.body.fname;
		let lname = req.body.lname;
		let dob = req.body.dob;
		let p = req.body.provider;
		let memberID = req.body.memberID;

		let translate = {
			"Aetna": "00001",
			"AmeriHealth (DE, NJ, PA)": "000929",
			"AmeriHealth Administrators": "00460",
			"AmeriHealth Caritas DC": "00996",
			"AmeriHealth Caritas Delaware": "01413",
			"AmeriHealth Caritas Iowa": "00997",
			"AmeriHealth Caritas Louisiana (LaCare)": "00998",
			"AmeriHealth Caritas PA": "00351",
			"AmeriHealth Caritas VIP Care Plus": "00999",
			"AmeriHealth New Jersey": "01000",
			"AmeriHealth Northeast Pennsylvania": "01001",
			"AmeriHealth Pennsylvania": "01002",
			"AmeriHealth VIP Care": "01003",
			"Blue Cross Blue Shield": "S001",
			"Capital Blue Cross": "00060",
			"Cigna": "00510",
			"Independence Blue Cross": "00115",
			"Highmark": "01136",
			"Magellan": "00676",
			"Optum": "UHG007",
			"United Healthcare": "00192"
		};
		console.log("Got Eligibility Query");
		console.log(req.body);
		let cacheKey = translate[p]+memberID
		if (Object.keys(cache).includes(cacheKey) && cache[cacheKey].ttl > new Date()) {
			// cache hit
			console.log(`Hot Cache: ${JSON.stringify(cache[cacheKey].data)}`);
			res.send(cache[cacheKey].data);
			return;
		} else {
			delete cache[cacheKey];
		}

		let payload = await axios.post(`https://api.pverify.com/Token`, body, config={
			headers: {"Content-Type": "application/x-www-form-urlencoded", "Client-API-Id": process.env.PVERIFY_CLIENT_ID}
		});
		let token = payload.data.access_token;
		console.log(`Got Token ${token}`);

		let ts = new Date();

		if (!translate[p]) {
			let resp = {
				status: "Failed",
			}
			res.status(500).send(resp);
			return;
		}

		body = {
			"payerCode": translate[p],
			"provider": {
				"lastName": "Brightside Counseling LLC",
				"npi": "1649556770"
			},
			"subscriber": {
				"memberId": memberID,
				"firstName": fname,
				"lastName": lname,
				"dob": dob
			},
			"isSubscriberPatient": "True",
			"doS_StartDate": (ts.getMonth()+1).toString().padStart(2, "0") + "/" + ts.getDate().toString().padStart(2, "0") + "/" + ts.getFullYear(),
			"doS_EndDate": (ts.getMonth()+1).toString().padStart(2, "0") + "/" + ts.getDate().toString().padStart(2, "0") + "/" + ts.getFullYear(),
			"practiceTypeCode": "21",
			"location": "PA",
		}

		console.log(`Sending payload: ${JSON.stringify(body)}`)

		try {
			let start = new Date().getTime();
			payload = await axios.post('https://api.pverify.com/API/EligibilitySummary', body, config={
				headers: {
					"Content-Type": "application/json",
					"Client-API-Id": process.env.PVERIFY_CLIENT_ID,
					"Authorization": `Bearer ${token}`
				}
			});
			let eligibility = payload.data;
			console.log(`Got Summary: ${JSON.stringify(eligibility)}. Elapsed Time ${new Date().getTime()-start}`);

			let resp = {
				status: eligibility?.PlanCoverageSummary?.Status ? eligibility?.PlanCoverageSummary?.Status : "Failed",
				planName: eligibility?.PlanCoverageSummary?.PlanName ? eligibility?.PlanCoverageSummary?.PlanName : "N/A",
				groupName: eligibility?.PlanCoverageSummary?.GroupName ? eligibility?.PlanCoverageSummary?.GroupName : "N/A",
				copay: eligibility?.MentalHealthSummary?.CoPayInNet?.Value ? eligibility?.MentalHealthSummary?.CoPayInNet?.Value : "N/A",
				coInsuranceInNet: eligibility?.MentalHealthSummary?.CoInsInNet?.Value ? eligibility?.MentalHealthSummary?.CoInsInNet?.Value : "" + " " + eligibility?.MentalHealthSummary?.CoInsInNet?.Notes ? eligibility?.MentalHealthSummary?.CoInsInNet?.Notes : "",
				memberId: eligibility?.MiscellaneousInfoSummary?.MemberID ? eligibility?.MiscellaneousInfoSummary?.MemberID : memberID,
				provider: eligibility?.PayerName ? eligibility?.PayerName : p,
				subscriber: eligibility?.DemographicInfo.Subscriber.FullName ? eligibility?.DemographicInfo.Subscriber.FullName : fname + " " + lname,
				indivDeductibleInNet: eligibility?.HBPC_Deductible_OOP_Summary?.IndividualDeductibleInNet?.Value ? eligibility?.HBPC_Deductible_OOP_Summary?.IndividualDeductibleInNet?.Value : "" + " " + eligibility?.HBPC_Deductible_OOP_Summary?.IndividualDeductibleInNet?.Notes ? eligibility?.HBPC_Deductible_OOP_Summary?.IndividualDeductibleInNet?.Notes : "",
				indivDeductibleInNetRemaining: eligibility?.HBPC_Deductible_OOP_Summary?.IndividualDeductibleRemainingInNet?.Value ? eligibility?.HBPC_Deductible_OOP_Summary?.IndividualDeductibleRemainingInNet?.Value : "" + " " + eligibility?.HBPC_Deductible_OOP_Summary?.IndividualDeductibleRemainingInNet?.Notes ? eligibility?.HBPC_Deductible_OOP_Summary?.IndividualDeductibleRemainingInNet?.Notes : "",
				famDeductibleInNet: eligibility?.HBPC_Deductible_OOP_Summary?.FamilyDeductibleInNet?.Value ? eligibility?.HBPC_Deductible_OOP_Summary?.FamilyDeductibleInNet?.Value : "" + " " + eligibility?.HBPC_Deductible_OOP_Summary?.FamilyDeductibleInNet?.Notes ? eligibility?.HBPC_Deductible_OOP_Summary?.FamilyDeductibleInNet?.Notes : "",
				famDeductibleInNetRemaining: eligibility?.HBPC_Deductible_OOP_Summary?.FamilyDeductibleRemainingInNet?.Value ? eligibility?.HBPC_Deductible_OOP_Summary?.FamilyDeductibleRemainingInNet?.Value : "" + " " + eligibility?.HBPC_Deductible_OOP_Summary?.FamilyDeductibleRemainingInNet?.Notes ? eligibility?.HBPC_Deductible_OOP_Summary?.FamilyDeductibleRemainingInNet?.Notes : "",
			}
			let ttlTwoWeeks = new Date();
			ttlTwoWeeks.setDate(ttlTwoWeeks.getDate() + 2 * 7);
			cache[translate[p]+memberID] = {data: resp, ttl: ttlTwoWeeks};
			console.log(`Returning payload: ${JSON.stringify(resp)}`);
			res.send(resp); 
		} catch (err) {
			let resp = {
				status: "Failed",
			}
			console.error("GOT ERROR: ", err.message);
			console.log(`Returning payload: ${JSON.stringify(resp)}`);
    		res.status(500).send(resp);
		}
		
  } catch(err) {
		console.error(err.message)
		res.status(500).send({status: "Failed"});
	}
});
