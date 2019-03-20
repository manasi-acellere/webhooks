import {runScan, getRunAnalysisDTO, abortScan, getScanProgress} from './../../../services/scan';
import log from './../../../utils/logger';
import * as cf from './../../../utils/common-functions';
import * as gammaConfig from './../../../core/config';
import * as db from './../../../component/db';
import * as pullRequestService from './pullRequest.service';
import request from 'request';
const errors = require('throw.js');
import * as gamma from './../../../core/gamma';
import _ from 'underscore';
import __ from 'lodash'; 

const PR_SCAN_REPO_URL = `${gammaConfig.analysisDBDetails.analysisHost}rest/gws/reviewRequest`;
const PR_ABORT_REPO_URL = `${gammaConfig.analysisDBDetails.analysisHost}rest/gws/abortReviewRequest`;
const GET_PROGRESS_SCAN_URL = `${gammaConfig.analysisDBDetails.analysisHost}rest/gws/getProgressReviewRequest`;

export function pickRepoFromPRQueue(req) {
    log.debug('INSIDE PICK REPO FROM QUEUE FUNCTION FOR REQUEST');
    // check first if any PR scan is in progress
    // if in progress wait
    // else take fist entry from PR queue and send it to GWS and change status to 'IN_PROGRESS'
    try {
        let sqlQuery = `select * from review_request_queue where status = 'IN_PROGRESS'`;
        return db.gammaDbPool.query(sqlQuery, [])
        .then(reviewRequest=>{
            if (reviewRequest.length == 0) {
                sqlQuery = `select rq.*, r.primary_data, s.subsystem_id as repository_id , t.tenant_uid from review_request_queue rq, review_requests r , subsystems s , tenant t
                            where rq.repository_uid = s.subsystem_uid and s.tenant_id = t.id and r.id = rq.review_request_id and rq.status = 'QUEUED'
                            order by id limit 1 `;
                return db.gammaDbPool.query(sqlQuery, [])
                .then(queueData=>{
                    if(queueData.length) {
                        let a;
                        if(true)
                        {
                           // alert('here');
                            return false;
                            alert('hello');
                        }
                        req.body.scanId = queueData[0].session_id;
                        req.body.repositoryId = queueData[0].repository_id;
                        req.params.repositoryUid = queueData[0].repository_uid;
                        let payloadPrimaryData = queueData[0].primary_data;
                        var params = {
                            'tenant_uid': queueData[0].tenant_uid,
                            'subsystem_uid': queueData[0].repository_uid,
                            'subsystem_uid': queueData[0].repository_uid
                        };
                        let payloadData = {
                            "reviewId": payloadPrimaryData.id + "",
                            "diffUrl": `${payloadPrimaryData.repoUrl}/diffstat/${payloadPrimaryData.sourceCommitId}..${payloadPrimaryData.destinationCommitId}`,
                            "oldCommitId": payloadPrimaryData.destinationCommitId,
                            "newCommitId": payloadPrimaryData.sourceCommitId,
                            "srcUrl": `${payloadPrimaryData.repoUrl}/src/`,
                            "srcDir": cf.actualPath(gammaConfig.analysisDBDetails.data_src, params),
                            "newFileList": payloadPrimaryData.newFileList,
                            "oldFileList": payloadPrimaryData.oldFileList
                        };
                        req.body.payloadData = payloadData;
                        updateScanStatusToRemote(queueData[0].session_id, queueData[0].review_request_id, queueData[0].repository_uid, 'INPROGRESS');
                        sendPRScanRequest(req);
                        debugger;
                    }
                });
            }
        });
    } catch (error) {
        let errorLog = new errors.InternalServerError(error.message, 1018);
        log.error(errorLog);
    }
}

export async function scan(req, res, next) {
    let reviewRequestRepositories = {
        "repository_uid": req.params.repositoryUid,
        "queueStatus":"QUEUED"
    };
    let sqlQuery = `select * from review_requests where review_request_id = $1`;
    return req.gamma.query(sqlQuery, [req.params.pullRequestId], next)
    .then(reviewRequestId=>{
        if (reviewRequestId.length) {
            let primaryData = reviewRequestId[0].primary_data;
            return pullRequestService.insertReviewRequestQueue(req.session.tenant_id, reviewRequestId[0].id, reviewRequestRepositories, primaryData.sourceCommitId, primaryData.destinationCommitId, primaryData.updatedOn, true)
            .then(() => {
                pickRepoFromPRQueue(req);
                res.status(200).json({
                    status: 'success',
                    message: "Pull request scan started successfully.",
                    details: "Pull request scan started successfully."
                });
            });
        }
    })
}

function sendPRScanRequest(req) {
    getRunAnalysisDTO(req)
    .then(runScanDTO=>{
        PRScanDTO = runScanDTO.responseDTO;
        PRScanDTO.scanSettings.header.sessionId = req.body.scanId;
        PRScanDTO.scanSettings.header.analysisMode = "REVIEW";
        PRScanDTO.scm.repoDTO.payloadData = req.body.payloadData;
        PRScanDTO.scanSettings.dataDir = PRScanDTO.scanSettings.dataDir +'_review';

        let replacedconnString = (PRScanDTO.responseEndPoint.connString).replace('scans', 'prscans');
        replacedconnString = (replacedconnString).replace(gammaConfig.apiVersion, 'views');
        PRScanDTO.responseEndPoint.connString = replacedconnString;

        let splitLocalDirectoryPath = (PRScanDTO.scm.repoDTO.localDirectoryPath).split('checkouts');
        PRScanDTO.scm.repoDTO.localDirectoryPath = splitLocalDirectoryPath[0] + 'reviewdata/' + req.params.repositoryUid + '/' + PRScanDTO.scm.repoDTO.payloadData.reviewId;

        // run PR scan
        runScan(PRScanDTO, PR_SCAN_REPO_URL)
        .then(()=>{
            updatePRQueueStatus({
                'status': 'IN_PROGRESS',
                'sessionId': req.body.scanId,
                'repositoryUid': req.params.repositoryUid,
                'reviewRequestId': req.body.payloadData.reviewId,
                'tenantId': PRScanDTO.tenant_id
            })
            .then(()=>{
                log.info(`SCAN REQUEST SENT TO GAMMA SERVICE : [sessionId : ${req.body.scanId}, repoId : ${req.params.repositoryUid}`);
            });
        })
        .catch(error => {
            log.info(`FAILING PR SCAN AS GAMMA SERVICE IS NOT AVAILABLE TO START SCAN [sessionId : ${req.body.scanId}, repoId : ${req.params.repositoryUid}]`);
            log.error(error);
            forceFailPRScanRequest(req.body.scanId, req.params.repositoryUid, PRScanDTO.tenant_id);
        });
    })
    .catch(error=>{
        log.error(error);
    })
}

export async function abort(req, res, next) {
    let sqlQuery = `select status, review_request_id from review_request_queue where session_id=$1`;
    return req.gamma.query(sqlQuery, [req.params.scanId])
    .then(requestStatus=>{
        if (requestStatus.length) {
            if (requestStatus[0].status == 'IN_PROGRESS') {
                // abort PR scan
                abortScan(req.params.scanId, PR_ABORT_REPO_URL)
                .then(() => {
                    log.info(`ABORT REQUEST SENT TO GAMMA SERVICE : [sessionId : ${req.params.scanId}, repoId : ${req.params.repositoryUid}`);
                    res.status(200).json({
                        status: 'success',
                        message: 'Abort request sent successfully.',
                        details: 'Abort request sent successfully.'
                    });
                })
                .catch(error => {
                    log.info(`FAILING PR SCAN AS GAMMA SERVICE IS NOT AVAILABLE TO ABORT SCAN [sessionId : ${req.params.scanId}, repoId : ${req.params.repositoryUid}`);
                    forceFailPRScanRequest(req.params.scanId, req.params.repositoryUid, req.session.tenant_id);
                    return next(error);
                });
            }
            else if (requestStatus[0].status == 'QUEUED') {
                updatePRQueueStatus({
                        'status': 'CANCEL',
                        'sessionId': req.params.scanId,
                        'repositoryUid': req.params.repositoryUid,
                        'reviewRequestId': requestStatus[0].review_request_id,
                        'tenantId':req.session.tenant_id
                })
                .then(() => {
                    log.info(`CANCEL REQUEST SENT TO GAMMA SERVICE : [sessionId : ${req.params.scanId}, repoId : ${req.params.repositoryUid}`);
                    res.status(200).json({
                        status: 'success',
                        message: 'Abort request sent successfully.',
                        details: 'Abort request sent successfully.'
                    });
                });
            }
        }
        else {
            return next(new errors.CustomError("NoContentToDisplay", "No content to display", 204, 1026));
        }
    });
}

function forceFailPRScanRequest(scanId, repositoryUid, tenantId) {
    var parsedJson = {};
    parsedJson.status = 'FAIL';
    parsedJson.message = 'ANALYSER_FAILED';
    parsedJson.messageType = 'ERROR';
    parsedJson.sessionId = scanId;
    parsedJson.tenantId = tenantId;
    var req = {
        'params': {
            'repositoryUid': repositoryUid
        },
        'body': parsedJson
    };
    var res = {
        'json': function (data) {
            return true;
        }
    };
    setPRScanStatus(req, res, null);
}

//this function will be called by GWS for scan updates
export async function setPRScanStatus(req, res, next) {
    let parsedJson = {}, status = '';
    try {
        parsedJson = req.body;
        sessionId = parsedJson.sessionId;
        repositoryUid = req.params.repositoryUid;
        status = parsedJson.status;
        tenantId = parsedJson.tenantId;
        message = (parsedJson.message) ? cf.parseString(parsedJson.message) : '';
        log.info(`GWS STATUS [sessionId : ${sessionId}, repoId : ${repositoryUid}, status : ${status}, message : ${message}]`);

        res.json({
            "status": 200,
            "message": "OK"
        });
        if (status == 'SUCCESS' || status == 'FAIL' || status == 'ABORT') {
            //log.info(`GWS STATUS [sessionId : ${sessionId}, repoId : ${repositoryUid}, status : ${status}, message : ${message}]`);
            let sqlQuery = `select review_request_id, repository_uid from review_request_queue where session_id=$1`;
            return db.gammaDbPool.query(sqlQuery, [sessionId])
            .then(reviewRequest=>{
                if (reviewRequest.length > 0) {
                    updatePRQueueStatus({
                        'status': status,
                        'sessionId': sessionId,
                        'repositoryUid': repositoryUid,
                        'reviewRequestId': reviewRequest[0].review_request_id,
                        'tenantId': tenantId
                    })
                    .then(() => {
                        sqlQuery = `select count(id) from review_request_queue where review_request_id = $1
                                and (status = 'IN_PROGRESS' OR status = 'QUEUED')`;
                        db.gammaDbPool.query(sqlQuery, [reviewRequest[0].review_request_id])
                        .then(countDetails => {
                            if (!countDetails.length || parseInt(countDetails[0].count) == 0) {
                                updateScanStatusToRemote(sessionId, reviewRequest[0].review_request_id, reviewRequest[0].repository_uid, 'SUCCESSFUL');
                            }
                            req.session = {};
                            req.session.tenant_id = tenantId;
                            pickRepoFromPRQueue(req);
                        });
                    })
                    .catch(error=>{
                        log.error(error);
                    });
                }
            });
        }
    } catch (error) {
        let errorLog = new errors.InternalServerError(error.message, 1018);
        log.error(errorLog);
    }
}

function updatePRQueueStatus(updateDetails) {
    sqlQuery = `update review_request_queue set status=$1 , updated_on = now() where session_id=$2 and repository_uid=$3`;
    return db.gammaDbPool.query(sqlQuery, [updateDetails.status, updateDetails.sessionId, updateDetails.repositoryUid])
    .then(() => {
        log.info("EMITTING UPDATE EVENT TO CLIENT FOR repositoryUid : " + updateDetails.repositoryUid + " status : " + updateDetails.status + " tenant : " + updateDetails.tenantId);
        gamma.socket.emitReviewRequestStatus(updateDetails.tenantId, {
            status: updateDetails.status,
            repositoryUid: updateDetails.repositoryUid,
            reviewRequestId: updateDetails.reviewRequestId
        });
        return true;
    })

}
//Get count of major and minor issues to post on VCA statuses.
function getIssuesCount(issueType){
    let issuesObj = {
                addedMajorIssues: 0,
                totalAddedIssues :0,
                fixedMajorIssues:0,
                totalFixedIssues :0
            };                                
    let addedIssuesCheck = { '1': false, '2': true };
    let fixedIssuesCheck = { '1': true, '2': false };
    issuesObj.addedMajorIssues +=  ((issueType).filter(d=>{
        if(__.isEqual(d.occurrence, addedIssuesCheck)){
            issuesObj.totalAddedIssues++; 
        }
        return (__.isEqual(d.occurrence, addedIssuesCheck) && (d.criticality == 'high' || d.criticality == 'critical'));
    })).length;

    issuesObj.fixedMajorIssues +=  ((issueType).filter(d=>{
        if(__.isEqual(d.occurrence, fixedIssuesCheck)){
            issuesObj.totalFixedIssues++; 
        }
        return (__.isEqual(d.occurrence, fixedIssuesCheck) && (d.criticality == 'high' || d.criticality == 'critical'));
    })).length;

    return issuesObj;
}
function getDescription(totalAddedMajorIssues,totalAddedMinorIssues,totalFixedMajorIssues, totalFixedMinorIssues)
{
    // "Gamma Scan Complete."+ 
    // "New Issues: " + totalAddedMajorIssues +" Major, "+ totalAddedMinorIssues+" Minor"+"\n"+
    // "Fixed Issues: "+totalFixedMajorIssues+" Major, "+ totalFixedMinorIssues +" Minor" +"\n"

    let str="",str1="", str2="", str3="", str4="", addedCount=0, fixCount =0;
  
    if(totalAddedMajorIssues>0)
    {
        addedCount++;
        str1 = "New Issues: "+totalAddedMajorIssues +" Major ";
    }   
    if(totalAddedMinorIssues >0)
    {
        if(addedCount>0)
            str2 = totalAddedMinorIssues+" Minor";
        else
            str2 = "New Issues: "+totalAddedMinorIssues+" Minor";  
    }
    if(totalFixedMajorIssues >0)
    {
        fixCount++;
        str3 = "Fixed Issues: " + totalFixedMajorIssues+" Major ";
    }
    if(totalFixedMinorIssues >0)
    {
        if(fixCount >0)
            str4 = totalFixedMinorIssues +" Minor";
        else
            str4 = "Fixed Issues: " + totalFixedMinorIssues +" Minor";
    }

    str = "Gamma Scan Complete. "+ str1+str2+"\n"+str3+str4;
    return str;
}

export function updateScanStatusToRemote(sessionId, reviewRequestId, repositoryUid, status) {
    log.info("UPDATING STATUS TO REMOTE : reviewRequestId => " + reviewRequestId + " repositoryUid => " + repositoryUid);
    //let sqlQuery = `select w.repository_url,w.tenant_id, r.primary_data, t.tenant_uid from review_requests r, webhooks w, tenants t where r.webhook_id = w.id and t.id=w.tenant_id and r.id = $1`;
    let sqlQuery = 'select w.repository_url,w.tenant_id, r.primary_data, t.tenant_uid from review_requests r, webhooks w, tenant t where r.webhook_id = w.id and r.id = $1 and t.id=w.tenant_id'
    console.log("IN FUNCION after query");
    db.gammaDbPool.query(sqlQuery, [reviewRequestId])
        .then(webhookDetails => {
            if (webhookDetails.length) {
                db.getCoronaDBSubdomainPool(webhookDetails[0].tenant_uid)
                .then(dbpool => {
                    //sqlQuery ='select r.summary from review_request r, subsystems s  where r.subsystem_id=s.id and r.review_id = $1 and s.subsystem_uid=$2';
                    sqlQuery = 'select r.details from review_request r, subsystems s  where r.subsystem_id=s.id and r.review_id = (select review_id from review_request where subsystem_id=(select id from subsystems where subsystem_uid=$1) and s.subsystem_uid= $1)'
                    dbpool.query(sqlQuery, [repositoryUid])
                    .then(summary=>{
                        if(summary.length)
                        {
                            let codeIssuesCountObj;
                            let addedMajorCodeIssues=0,totalAddedCodeIssues=0,fixedMajorCodeIssues=0,totalFixedCodeIssues=0;
                            let designIssuesCountObj;
                            let addedMajorDesignIssues=0,totalAddedDesignIssues=0,fixedMajorDesignIssues=0,totalFixedDesignIssues=0;
                            
                            (summary[0].details.pr_details).forEach(prDetail=>{
                                //codeissues
                                codeIssuesCountObj = getIssuesCount(prDetail.code_issues);
                                addedMajorCodeIssues += codeIssuesCountObj.addedMajorIssues;
                                totalAddedCodeIssues += codeIssuesCountObj.totalAddedIssues;
                                fixedMajorCodeIssues += codeIssuesCountObj.fixedMajorIssues;
                                totalFixedCodeIssues += codeIssuesCountObj.totalFixedIssues;
                                //designissues
                                designIssuesCountObj = getIssuesCount(prDetail.design_issues);
                                addedMajorDesignIssues += designIssuesCountObj.addedMajorIssues;
                                totalAddedDesignIssues += designIssuesCountObj.totalAddedIssues;
                                fixedMajorDesignIssues += designIssuesCountObj.fixedMajorIssues;
                                totalFixedDesignIssues += designIssuesCountObj.totalFixedIssues;
               
                            });
                            //Added
                            let addedMinorCodeIssues = totalAddedCodeIssues - addedMajorCodeIssues;
                            let addedMinorDesignIssues = totalAddedDesignIssues - addedMajorDesignIssues;
                            let totalAddedMinorIssues = addedMinorCodeIssues + addedMinorDesignIssues;
                            let totalAddedMajorIssues = addedMajorCodeIssues + addedMajorDesignIssues;
                            //Fixed
                            let fixedMinorCodeIssues = totalFixedCodeIssues - fixedMajorCodeIssues;
                            let fixedMinorDesignIssues = totalFixedDesignIssues - fixedMajorDesignIssues;
                            let totalFixedMinorIssues = fixedMinorCodeIssues + fixedMinorDesignIssues;
                            let totalFixedMajorIssues = fixedMajorCodeIssues + fixedMajorDesignIssues;
  
                            let vcType = (typeof webhookDetails[0].primary_data.vcType !== 'undefined') ? webhookDetails[0].primary_data.vcType.toLowerCase() : 'bitbucket';
                            pullRequestService.getReposForPR(webhookDetails[0].repository_url)
                            .then(repoDetails => {
                                if (repoDetails.length) {
                                    let repoMeta, repoUrl, isVcSupport, isGitSupport, repoProvider, repoType, repoSlug, repoOwner, repoUser, repoPass, headerData, cloudApiUrl;
                                    // Parse url
                                    repoMeta = pullRequestService.getRepositoryProvider(repoDetails[0]);
                                    // Repo meta
                                    repoUrl = webhookDetails[0].primary_data.repoUrl;
                                    isVcSupport = (typeof repoMeta.isVcSupport !== 'undefined') ? repoMeta.isVcSupport : '';
                                    isGitSupport = (typeof repoMeta.isGitSupport !== 'undefined') ? repoMeta.isGitSupport : '';
                                    repoProvider = (typeof repoMeta.providerName !== 'undefined') ? repoMeta.providerName : '';
                                    repoType = (typeof repoMeta.repoType !== 'undefined') ? repoMeta.repoType : '';
                                    repoSlug = (typeof repoMeta.repoSlug !== 'undefined') ? repoMeta.repoSlug : '';
                                    repoOwner = (typeof repoMeta.repoOwner !== 'undefined') ? repoMeta.repoOwner : '';
                                    repoUser = (typeof repoMeta.username !== 'undefined') ? repoMeta.username : '';
                                    repoPass = (typeof repoMeta.password !== 'undefined') ? repoMeta.password : '';
                                    // Headers
                                    headerData = { "content-type": "application/json" };
                                    // Basic auth
                                    if (isVcSupport) {
                                        // Version control
                                        if (repoProvider == 'bitbucket') {
                                            headerData['Authorization'] = "Basic " + cf.getEncryptedBasicToken(repoUser, repoPass);
                                        } else if (repoProvider == 'github') {
                                            headerData['Authorization'] = "token " + repoPass;
                                        }
                                    } else {
                                        // Git providers
                                        if ((repoProvider == 'bitbucket' || repoProvider == 'github') && repoType == 'private') {
                                            headerData['Authorization'] = "Basic " + cf.getEncryptedBasicToken(repoUser, repoPass);
                                        }
                                    }
                                    // Request data
                                    if (repoProvider == 'bitbucket') {
                                        // Prepare diffstat url
                                        cloudApiUrl = `${webhookDetails[0].primary_data.sourceCommitUrl}/statuses/build`;
                                        if(status != 'INPROGRESS' && totalAddedMajorIssues > 0){
                                            status = 'FAILED';
                                        }
                                    } else if (repoProvider == 'github') {
                                        // Prepare diffstat url
                                        cloudApiUrl = `${webhookDetails[0].primary_data.repoUrl}/statuses/${webhookDetails[0].primary_data.sourceCommitId}`;
                                        headerData['User-Agent'] = 'Awesome-Octocat-Ap';
                                        // Handle status for Github
                                        if (status == 'INPROGRESS') {
                                            status = "pending";
                                        }
                                        else if (status == 'SUCCESSFUL') {
                                            status = "success";
                                        }
                                        if(status != "pending" && totalAddedMajorIssues > 0){
                                            status = 'failure';
                                        }
                                    }

                                    let description = getDescription(totalAddedMajorIssues,totalAddedMinorIssues,totalFixedMajorIssues, totalFixedMinorIssues);

                                    // Exclude open source repos to update status
                                    if ((isVcSupport || isGitSupport) && repoType == 'private') {
                                        log.debug(`Remote status ${status} update URL: ${cloudApiUrl}`);
                                        cf.getDomainURL(webhookDetails[0].tenant_id, "id").then(function (domainURL) {
                                            // Prepare json body
                                            if (repoProvider == 'bitbucket') {
                                                if(status == 'FAILED' || status == 'SUCCESSFUL')
                                                {
                                                    jsonBody = {
                                                        "state": status,
                                                        "key": "Gamma",
                                                        "name": "Gamma",
                                                        "url": domainURL,
                                                        "description": description            
                                                    };
                                                }
                                                else if(status == 'INPROGRESS')
                                                {
                                                    jsonBody = {
                                                        "state": status,
                                                        "context": "Gamma",
                                                        "target_url": domainURL,
                                                        "description": "Gamma Scan: Pending"
                                                    };
                                                }
                                               
                                            } else if (repoProvider == 'github') {
                                                if(status == 'failure' || status == 'success')
                                                {
                                                    jsonBody = {
                                                        "state": status,
                                                        "context": "Gamma",
                                                        "target_url": domainURL,
                                                        "description": description
                                                    };
                                                }
                                                else if(status == 'pending')
                                                {
                                                    jsonBody = {
                                                        "state": status,
                                                        "context": "Gamma",
                                                        "target_url": domainURL,
                                                        "description": "Gamma Scan: Pending"
                                                    };
                                                }
                                               
                                            }
                                            // Call
                                            request({
                                                url: cloudApiUrl,
                                                method: 'POST',
                                                timeout: 20000,
                                                headers: headerData,
                                                rejectUnauthorized: false,
                                                //Lets post the following key/values as form
                                                json: jsonBody
                                            },
                                                function (error, response, body) {
                                                    if (error) {
                                                        let errorLog = new errors.ServiceUnavailable(`${vcType} service unavailable`, 1021);
                                                        log.error(errorLog);
                                                    } else {
                                                        if (response.statusCode == 200 || response.statusCode == 201) {
                                                            log.info(`SUCCESSFULLY UPDATED STATUS => ${status} TO REMOTE FOR ${vcType} [sessionId: ${sessionId} repoId : ${repositoryUid}]`);
                                                        } else {
                                                            let errorLog = new errors.ServiceUnavailable(`${vcType} service unavailable`, 1021);
                                                            log.error(errorLog);
                                                        }
                                                    }
                                                });
                                        });
                                    }
                                }
                            })
                            .catch(error => {
                                log.error(error);
                            });
                        }
                     
                    });
                });


                
            }
        });
}

// this is the service which is called periodically to chk if PR scan for given repository is running or not
// it requests to GWS only if difference betwn last updated time and current time is more than gammaConfig.analysisWaitTime
export function getIsPRAliveStatus() {
    try {
        let sqlQuery = `select rrq.*, s.tenant_id from review_request_queue rrq, subsystems s where rrq.repository_uid = s.subsystem_uid and status = 'IN_PROGRESS'`;
        return db.gammaDbPool.query(sqlQuery, [])
        .then(reviewRequest => {
            if (reviewRequest.length > 0) { // Scan is in progress for some PR. Now check if its actually running at GWS
                let scanId = reviewRequest[0].session_id;
                let tenantId = reviewRequest[0].tenant_id;
                let repositoryUid = reviewRequest[0].repository_uid;
                let lastUpdatedTimestamp = reviewRequest[0].updated_on;
                var currentTimestamp = new Date();
                var difference = currentTimestamp.getTime() - lastUpdatedTimestamp.getTime();
                var minutes = parseInt(difference / (1000 * 60));
                if (minutes >= gammaConfig.analysisDBDetails.analysisWaitTime && scanId != '' && scanId) {
                    log.info(`SENDING GETPROGRESS REQUEST FOR [sessionId : ${scanId}, repoId : ${repositoryUid}]`);

                    getScanProgress(scanId, GET_PROGRESS_SCAN_URL)
                    .then((body) => {
                        let parsedJson = JSON.parse(body);
                        let oldScanId = scanId+"_1";
                        if ((parsedJson.status == 'PROCESSING' || parsedJson.status == 'START' || parsedJson.status == 'SCHEDULED' || parsedJson.status == 'INITIALIZED' || parsedJson.status == 'ABORTING' ||
                            ((parsedJson.status == 'SUCCESS' || parsedJson.status == 'ABORT' || parsedJson.status == 'FAIL') && parsedJson.sessionId == oldScanId))
                            && parsedJson.subsystemId == repositoryUid) {
                            log.info(`PR SCAN IS RUNNING FOR REPO [sessionId : ${scanId}, repoId : ${repositoryUid}]`);
                        } else if ((parsedJson.status == 'SUCCESS' || parsedJson.status == 'ABORT' || parsedJson.status == 'FAIL') && parsedJson.subsystemId == repositoryUid && parsedJson.sessionId == scanId) {
                            log.info(`PR SCAN IS NOT RUNNING FOR GIVEN REPO [sessionId : ${scanId}, repoId : ${repositoryUid}]`);

                            var req = {
                                'params': {
                                    'repositoryUid': repositoryUid
                                },
                                'body': parsedJson
                            };
                            var res = {
                                'json': function (data) {
                                    return true;
                                }
                            };
                            setPRScanStatus(req, res, null);
                        } else //status is false means analysis for given subsystem is not running.So we remove data from analysis queue and add it to analysis history with status as failed
                        {
                            log.info(`FAILING ANALYSIS BCOZ ANALYSIS IS NOT RUNNING FOR REPO [sessionId : ${scanId}, repoId : ${repositoryUid}]`);
                            forceFailPRScanRequest(scanId, repositoryUid, tenantId);
                        }
                    })
                    .catch(error=>{
                        log.error(error);
                        log.info(`FAILING PR SCAN BCOZ GAMMA SERVICE IS DOWN [sessionId : ${scanId}, repoId : ${repositoryUid}]`);
                        forceFailPRScanRequest(scanId, repositoryUid, tenantId);
                    });
                }
            }
        })

    } catch (error) {
        let errorLog = new errors.InternalServerError(error.message, 1018);
        log.error(errorLog);
    }
}
